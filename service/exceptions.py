class DownloadException(Exception):
    url: str

    def __init__(self, url: str):
        super().__init__(f"download {url} failed")
