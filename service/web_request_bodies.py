import marshmallow_dataclass
from marshmallow import EXCLUDE


@marshmallow_dataclass.dataclass
class DownloadModelData:
    class Meta:
        unknown = EXCLUDE

    type: str
    repo_id: str
    backend: str
    model_path: str
    additionalLicenseLink: str | None


@marshmallow_dataclass.dataclass
class DownloadModelRequestBody:
    data: list[DownloadModelData]
