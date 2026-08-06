class DownloadException(Exception):
    url: str

    def __init__(self, url: str):
        super().__init__(f"download {url} failed")


class HFReachabilityError(Exception):
    """Raised when the Hugging Face API could not be reached to answer a query
    (network timeout, connection error, transient HTTP failure).

    This is distinct from a repo/file genuinely not existing: the latter is a
    definitive negative answer, while this means we could not determine the
    answer at all and the caller should surface a connectivity error rather
    than treating the model as missing.
    """

    def __init__(self, repo_id: str, cause: Exception):
        self.repo_id = repo_id
        self.cause = cause
        super().__init__(
            f"could not reach Hugging Face to check {repo_id}: {type(cause).__name__}: {cause}"
        )
