class PolicyDenied(Exception):
    """A request was understood but is not allowed; always recorded in the audit log."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class NotFound(Exception):
    pass


class InvalidRequest(Exception):
    pass
