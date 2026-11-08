import re

_WORD = re.compile(r"[A-Za-zА-Яа-яЁё0-9]+")
_CAMEL = re.compile(r"(?<=[a-zа-я0-9])(?=[A-ZА-Я])")

STOPWORDS = frozenset(
    """
    a an and are as at be but by can could do does for from had has have how i if in into is it
    its me my of on or our please should so that the their them then there these this to us was
    we what when where which who why will with would you your about tell show give find explain
    use used using
    """.split()  # noqa: SIM905
    + """
    и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее
    мне было вот от меня еще нет о из ему теперь когда даже ну ли если уже или ни быть был него
    до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для
    мы тебя их чем была сам чтобы без будто чего раз тоже себе под будет ж тогда кто этот того
    """.split()  # noqa: SIM905
)


def tokenize(text: str) -> list[str]:
    """Lowercased word tokens with camelCase and snake_case identifiers split apart."""
    return [t.lower() for t in _WORD.findall(_CAMEL.sub(" ", text))]


def content_terms(text: str) -> list[str]:
    """Unique non-stopword terms in first-seen order."""
    seen: dict[str, None] = {}
    for token in tokenize(text):
        if token not in STOPWORDS and len(token) > 1:
            seen.setdefault(token, None)
    return list(seen)


def stem(token: str) -> str:
    """Crude English suffix stripping so "sending", "sends" and "send" compare equal."""
    if len(token) <= 4 or not token.isascii():
        return token
    if token.endswith("ies"):
        token = token[:-3] + "y"
    elif token.endswith("s") and not token.endswith("ss"):
        token = token[:-1]
    for suffix in ("ing", "ed"):
        if token.endswith(suffix) and len(token) - len(suffix) >= 3:
            token = token[: -len(suffix)]
            break
    return token[:-1] if token.endswith("e") and len(token) > 4 else token
