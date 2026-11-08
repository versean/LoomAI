import logging
import os
from functools import wraps
from uuid import uuid4

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from flask import Flask, g, jsonify, request
from werkzeug.exceptions import RequestEntityTooLarge
from werkzeug.utils import secure_filename

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024  # 25 MB upload cap

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

REGION = os.environ.get("AWS_REGION", "us-east-1")
BUCKET = os.environ.get("UPLOAD_BUCKET", "loomai")
MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
print("Using bucket:", BUCKET)

s3 = boto3.client("s3", region_name=REGION)
bedrock = boto3.client("bedrock-runtime", region_name=REGION)

# Bedrock Converse limits: ~4.5 MB per document, ~3.75 MB per image
MAX_ANALYZE_BYTES = 3 * 1024 * 1024
MAX_FILES = 20  # cap per /analyze call to limit time and cost

# extension -> content type stored in S3
ALLOWED_TYPES = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "pdf": "application/pdf",
    "txt": "text/plain",
    "md": "text/markdown",
    "json": "application/json",
}

# How each extension is handed to the model
IMAGE_FORMATS = {"png": "png", "jpg": "jpeg", "jpeg": "jpeg", "gif": "gif"}
DOCUMENT_FORMATS = {"pdf": "pdf"}  # txt is sent as plain text


# --- TEMPORARY: fake auth for local testing. Remove once real auth is wired in. ---
@app.before_request
def fake_auth():
    g.user_id = "123"


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not getattr(g, "user_id", None):
            return jsonify({"error": "Unauthorized"}), 401
        return fn(*args, **kwargs)

    return wrapper


@app.errorhandler(RequestEntityTooLarge)
def too_large(_):
    return jsonify({"error": "File too large"}), 413


@app.route("/upload", methods=["POST"])
@login_required
def upload():
    file = request.files.get("file")
    if not file or not file.filename:
        return jsonify({"error": "No file provided"}), 400

    filename = secure_filename(file.filename)
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

    if ext not in ALLOWED_TYPES:
        return jsonify({"error": "File type not allowed"}), 415

    # uuid prefix prevents overwriting; secure_filename keeps the key clean
    key = f"users/{g.user_id}/{uuid4().hex}-{filename}"

    try:
        s3.upload_fileobj(
            file.stream,
            BUCKET,
            key,
            ExtraArgs={
                "ContentType": ALLOWED_TYPES[ext],
                # Add these back one at a time if your role allows them:
                # "ContentDisposition": f'attachment; filename="{filename}"',
                # "ServerSideEncryption": "AES256",
            },
        )
    except (ClientError, BotoCoreError):
        logger.exception("S3 upload failed for user %s", g.user_id)
        return jsonify({"error": "Upload failed"}), 502

    return jsonify({"message": "Uploaded successfully", "key": key}), 201


def summarize_object(key, ext, prompt):
    """Download one S3 object and return the model's summary text."""
    body = s3.get_object(Bucket=BUCKET, Key=key)["Body"].read()

    content = [{"text": prompt}]
    if ext in IMAGE_FORMATS:
        content.append({"image": {"format": IMAGE_FORMATS[ext], "source": {"bytes": body}}})
    elif ext in DOCUMENT_FORMATS:
        content.append(
            {"document": {"format": DOCUMENT_FORMATS[ext], "name": "document", "source": {"bytes": body}}}
        )
    else:  # txt
        content.append({"text": "File contents:\n\n" + body.decode("utf-8", errors="replace")})

    response = bedrock.converse(
        modelId=MODEL_ID,
        messages=[{"role": "user", "content": content}],
        inferenceConfig={"maxTokens": 1000},
    )
    return response["output"]["message"]["content"][0]["text"]


@app.route("/analyze", methods=["GET", "POST"])
@login_required
def analyze():
    """Summarize every supported file the current user has in the bucket."""
    data = request.get_json(silent=True) or {}
    prompt = data.get("prompt") or request.args.get("prompt") or "Summarize this file clearly and concisely."
    prefix = f"users/{g.user_id}/"

    # 1. List the user's files
    try:
        objects = []
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=BUCKET, Prefix=prefix):
            objects.extend(page.get("Contents", []))
    except (ClientError, BotoCoreError):
        logger.exception("S3 list failed for user %s", g.user_id)
        return jsonify({"error": "Could not list files"}), 502

    objects = [o for o in objects if not o["Key"].endswith("/")]
    if not objects:
        return jsonify({"results": [], "message": "No files found"})

    skipped_for_limit = max(0, len(objects) - MAX_FILES)
    objects = objects[:MAX_FILES]

    # 2. Summarize each file; one failure doesn't stop the rest
    results = []
    for obj in objects:
        key = obj["Key"]
        ext = key.rsplit(".", 1)[-1].lower() if "." in key else ""

        if ext not in ALLOWED_TYPES:
            results.append({"key": key, "error": "File type not supported"})
            continue
        if obj["Size"] > MAX_ANALYZE_BYTES:
            results.append({"key": key, "error": "File too large to analyze (3 MB max)"})
            continue

        try:
            results.append({"key": key, "summary": summarize_object(key, ext, prompt)})
        except (ClientError, BotoCoreError) as e:
            logger.exception("Analysis failed for %s", key)
            results.append({"key": key, "error": f"Analysis failed: {e}"})

    # 3. Send everything back
    return jsonify({"count": len(results), "not_processed": skipped_for_limit, "results": results})


if __name__ == "__main__":
    # debug=True is for local development only
    app.run(debug=True, port=5000)