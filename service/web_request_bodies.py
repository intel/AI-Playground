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

@marshmallow_dataclass.dataclass
class ComfyUICustomNodesGithubRepoId:
    username: str
    repoName: str

@marshmallow_dataclass.dataclass
class ComfyUICustomNodesDownloadRequest:
    data : List[ComfyUICustomNodesGithubRepoId]

@marshmallow_dataclass.dataclass
class ComfyUIPackageInstallRequest:
    data : List[str]
