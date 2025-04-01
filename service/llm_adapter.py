from model_downloader import NotEnoughDiskSpaceException, DownloadException
from psutil._common import bytes2human
import llm_biz
from service_adapter import ServiceAdapter

class LLM_SSE_Adapter(ServiceAdapter):
    """
    Adapter for the default service backend.
    This class extends ServiceAdapter to maintain backward compatibility.
    """
    
    def error_callback(self, ex: Exception):
        """
        Extended error callback with additional error types specific to the service backend.
        """
        if (
            isinstance(ex, NotImplementedError)
            and ex.__str__() == "Access to repositories lists is not implemented."
        ):
            self.put_msg(
                {
                    "type": "error",
                    "err_type": "repositories_not_found",
                }
            )
        elif isinstance(ex, NotEnoughDiskSpaceException):
            self.put_msg(
                {
                    "type": "error",
                    "err_type": "not_enough_disk_space",
                    "need": bytes2human(ex.requires_space),
                    "free": bytes2human(ex.free_space),
                }
            )
        elif isinstance(ex, DownloadException):
            self.put_msg({"type": "error", "err_type": "download_exception"})
        elif isinstance(ex, llm_biz.StopGenerateException):
            pass
        else:
            # Fall back to the base implementation for other error types
            super().error_callback(ex)
