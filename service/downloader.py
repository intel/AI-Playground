from json import dumps
from os import path
import sys
from huggingface_hub import HfFileSystem, hf_hub_url


class ModelDownloaderApi:
    repo_id: str
    file_queue: list
    total_size: int
    fs: HfFileSystem
    repo_folder: str

    def __init__(self):
        self.file_queue = list()
        self.fs = HfFileSystem()

    def get_info(self, repo_id: str, is_sd=False):
        self.repo_id = repo_id
        self.repo_folder = repo_id.replace("/", "---")
        self.file_queue.clear()
        self.total_size = 0
        self.enum_file_list(repo_id, is_sd, True)
        print(dumps({"total_size": self.total_size, "file_list": self.file_queue}))

    def enum_file_list(self, enum_path: str, is_sd=False, is_root=True):
        list = self.fs.ls(enum_path, detail=True)
        for item in list:
            name: str = item.get("name")
            size: int = item.get("size")
            type: str = item.get("type")
            if type == "directory":
                self.enum_file_list(name, is_sd, False)
            else:
                # sd model ignore root .safetensors .pt .ckpt files
                if (
                    is_sd
                    and is_root
                    and (
                        name.endswith(".safetensors")
                        or name.endswith(".pt")
                        or name.endswith(".ckpt")
                    )
                ):
                    continue
                # ignore no used files
                elif (
                    name.endswith(".png")
                    or name.endswith(".gitattributes")
                    or name.endswith(".md")
                    or name.endswith(".jpg")
                ):
                    continue

                self.total_size += size
                relative_path = path.relpath(name, self.repo_id)
                subfolder = path.dirname(relative_path).replace("\\", "/")
                filename = path.basename(relative_path)
                url = hf_hub_url(
                    repo_id=self.repo_id, filename=filename, subfolder=subfolder
                )
                self.file_queue.append(
                    {
                        "name": name.replace(self.repo_id, self.repo_folder),
                        "size": size,
                        "url": url,
                    }
                )


if __name__ == "__main__":
    if len(sys.argv) == 1:
        exit(1)
    else:
        ModelDownloaderApi().get_info(
            sys.argv[1], int(sys.argv[2]) != 0 if sys.argv.__len__() > 2 else False
        )
