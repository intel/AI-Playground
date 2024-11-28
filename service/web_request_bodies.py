from typing import List

import marshmallow_dataclass
from marshmallow import EXCLUDE


@marshmallow_dataclass.dataclass
class DownloadModelData:
    class Meta:
        unknown = EXCLUDE
    type : int
    repo_id : str
    backend : str

@marshmallow_dataclass.dataclass
class DownloadModelRequestBody:
    data : List[DownloadModelData]
