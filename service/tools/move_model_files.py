# To be invoked by installer
# Usage: python move_model_files.py <src_dir> <target_dir>

import os
import sys


if len(sys.argv) != 3:
    print("Usage: python move_model_files.py <src_dir> <target_dir>")
    sys.exit(1)


src_dir = sys.argv[1]
target_dir = sys.argv[2]
if not os.path.exists(src_dir):
    print("Backup model directory does not exist: " + src_dir)
    sys.exit(1)
if not os.path.exists(target_dir):
    os.makedirs(target_dir)


log_file = os.path.join(target_dir, "copy.log")
if os.path.exists(log_file):
    os.remove(log_file)


def log(msg):
    print(msg)
    with open(log_file, "a") as f:
        f.write(msg + "\n")


def move_model_files(src_dir, target_dir):
    try:
        # for each file in src_dir, move it to target_dir if target path does not exist
        # otherwise, remove the target file and move the backup file to target path
        for root, dirs, files in os.walk(src_dir):
            for file in files:
                src_file = os.path.join(root, file)
                target_file = src_file.replace(src_dir, target_dir)
                if os.path.exists(target_file):
                    os.remove(target_file)
                    log(f"Removed existing {target_file}")
                tdir = os.path.dirname(target_file)
                if not os.path.exists(tdir):
                    os.makedirs(tdir)
                os.rename(src_file, target_file)
                log(f"Moved {src_file} to {target_file}")
    except Exception as e:
        log("Failed to recover model files: " + str(e))
        sys.exit(1)


move_model_files(src_dir, target_dir)
