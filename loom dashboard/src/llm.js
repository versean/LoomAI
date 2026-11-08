// Which Claude the conductor talks to.
//
//   HIVEMIND_PROVIDER=bedrock    -> Amazon Bedrock (default when AWS_REGION is set)
//   HIVEMIND_PROVIDER=anthropic  -> Anthropic API directly
//
// Bedrock auth uses the normal AWS chain: AWS_PROFILE, AWS_ACCESS_KEY_ID/SECRET,
// AWS_BEARER_TOKEN_BEDROCK, or SSO. Region comes from AWS_REGION.

import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";

const provider = (process.env.HIVEMIND_PROVIDER || (process.env.AWS_REGION ? "bedrock" : "anthropic")).toLowerCase();

export const PROVIDER = provider;

export const MODEL = process.env.HIVEMIND_MODEL
  || (provider === "bedrock" ? "anthropic.claude-opus-5-5" : "claude-opus-5-5");

export const client = provider === "bedrock"
  ? new AnthropicBedrockMantle({ awsRegion: process.env.AWS_REGION || "us-east-1" })
  : new Anthropic();

export function describeProvider() {
  return provider === "bedrock"
    ? `Amazon Bedrock (${process.env.AWS_REGION || "us-east-1"}) · ${MODEL}`
    : `Anthropic API · ${MODEL}`;
}

// Errors that won't fix themselves by retrying the next item: missing/bad credentials or model access.
export function isConfigError(err) {
  return err instanceof Anthropic.AuthenticationError || err?.status === 401 || err?.status === 403 || err?.status === 404
    || /authentication method|credential|region/i.test(err?.message || "");
}

export function friendlyError(err) {
  if (isConfigError(err) && err?.status !== 404) {
    return provider === "bedrock"
      ? "Bedrock rejected the credentials. Check AWS credentials, region, and that Claude model access is enabled in the Bedrock console."
      : "No valid Anthropic credentials. Set ANTHROPIC_API_KEY or run `ant auth login`.";
  }
  if (err?.status === 404) return `Model "${MODEL}" not found on ${provider}. Set HIVEMIND_MODEL to a model your account can use.`;
  if (err?.status === 429) return "Rate limited. The conductor will pick up the next item shortly.";
  return err?.message || String(err);
}
