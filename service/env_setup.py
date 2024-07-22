import subprocess
import sys
import argparse

# install rich
subprocess.check_call([sys.executable, "-m", "pip", "install", "rich", "-q"])

from rich.progress import Progress
from rich.console import Console
from rich.traceback import install

# Optional: Enable rich traceback to improve error handling output
install()

def install_package(package_name):
    try:
        subprocess.check_call([sys.executable, '-m', 'pip', 'install', package_name, "--no-cache-dir", "--no-warn-script-location"])
        return True
    except subprocess.CalledProcessError:
        return False

def install_packages_from_file(requirements_file):
    with open(requirements_file, 'r') as f:
        packages = [line.strip() for line in f if line.strip()]

    with Progress(transient=True) as progress:
        task = progress.add_task("[cyan]Installing packages...", total=len(packages))
        console = Console()

        for package in packages:
            result = install_package(package)
            if result:
                progress.update(task, advance=1, description=f"[green]Installed {package}")
            else:
                progress.update(task, advance=1, description=f"[red]Failed to install {package}")

            # Optional: Print update to console
            console.print(f"[cyan]Installing {package}... [green]Done" if result else f"[cyan]Installing {package}... [red]Failed")

def setup_env():
    parser = argparse.ArgumentParser(description='Setup script for environment.')
    parser.add_argument('-f', '--file', help='requirement file location')

    args = parser.parse_args()
    requirements_file = args.file
    install_packages_from_file(requirements_file)


setup_env()