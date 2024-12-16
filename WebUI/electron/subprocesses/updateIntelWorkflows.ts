import {appLoggerInstance} from "../logging/logger.ts";
import path, * as Path from "node:path";
import * as fs from "fs-extra";
import * as filesystem from "fs-extra";
import {copyFileWithDirs, existingFileOrError, spawnProcessAsync} from "./osProcessHelper.ts";
import {app} from "electron";

const logger = appLoggerInstance
const processLogHandler = (data: string) => {logger.info(data, logSourceName, true)}
const logSourceName = "updateIntelWorkflows"

const resourcesBaseDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, "../../../");
const externalRes = path.resolve(app.isPackaged ? process.resourcesPath : path.join(__dirname, "../../external/"));

const gitExePath = Path.join(resourcesBaseDir, "portable-git", "cmd" , "git.exe")
const workflowDirTargetPath = Path.join(externalRes, "workflows")
const workflowDirSpareGitRepoPath = Path.join(externalRes, "workflows_intel")
const intelWorkflowDirPath = Path.join(workflowDirSpareGitRepoPath, "WebUI", "external", "workflows")
const workflowDirBakTargetPath = Path.join(externalRes, "workflows_bak")

export async function updateIntelWorkflows(): Promise<UpdateWorkflowsFromIntelResult> {
    try {
        await fetchNewIntelWorkflows()
        await backUpCurrentWorkflows()
        await replaceCurrentWorkflowsWithIntelWorkflows()
        return {
            success: true,
            backupDir: workflowDirBakTargetPath
        }
    } catch (e) {
        logger.error(`updating intel workflows failed due to ${e}`, logSourceName, true)
        if (!filesystem.existsSync(workflowDirTargetPath)) {
            logger.info(`restoring previous workflows from  ${workflowDirBakTargetPath}`, logSourceName, true)
            await copyFileWithDirs(intelWorkflowDirPath, workflowDirTargetPath)
        }
        return {
            success: false,
            backupDir: workflowDirBakTargetPath
        }
    }
}

async function fetchNewIntelWorkflows() {
    const gitRef = "dev"
    const gitExe = existingFileOrError(gitExePath)
    const gitWorkDir = workflowDirSpareGitRepoPath
    await prepareSparseGitRepoDir(gitWorkDir)
    await prepareSparseGitCheckout(gitWorkDir, gitExe)
    await spawnProcessAsync(gitExe, ["checkout", gitRef], processLogHandler, {}, gitWorkDir)
    await spawnProcessAsync(gitExe, ["pull"], processLogHandler, {}, gitWorkDir)
    logger.info(`cloned current intel workflows from ${gitRef} into ${workflowDirBakTargetPath}`, logSourceName, true)

}

async function backUpCurrentWorkflows() {
    await copyFileWithDirs(workflowDirTargetPath, workflowDirBakTargetPath)
    logger.info(`backed up current user workflows at ${workflowDirBakTargetPath}`, logSourceName, true)
    return
}

async function replaceCurrentWorkflowsWithIntelWorkflows() {
    if (filesystem.existsSync(workflowDirTargetPath)) {
        logger.warn(`removing previous workflow dir at ${workflowDirTargetPath}`, logSourceName, true)
        await fs.promises.rm(workflowDirTargetPath, {recursive: true, force: true})
    }
    await fs.promises.mkdir(workflowDirTargetPath, { recursive: true });
    await copyFileWithDirs(intelWorkflowDirPath, workflowDirTargetPath)
    logger.info(`repopulated workflow dir with intel workflows at ${workflowDirTargetPath}`, logSourceName, true)
}

async function prepareSparseGitRepoDir(dirPath: string) {
    if (!filesystem.existsSync(dirPath)) {
        await fs.promises.mkdir(dirPath, { recursive: true });
        logger.info(`Created containment directory at ${dirPath}`, logSourceName, true)
        return
    }
    logger.info(`reusing existing dir ${dirPath} for fetching remote workflows`, logSourceName, true)
}


async function prepareSparseGitCheckout(workDir: string, gitExe: string) {
    const spareCheckoutConfigFile = path.join(workDir, ".git" ,"info", "sparse-checkout")
    if (!filesystem.existsSync(spareCheckoutConfigFile)) {
        await spawnProcessAsync(gitExe, ["init"] , processLogHandler, {}, workDir)
        await spawnProcessAsync(gitExe, ["config", "core.sparseCheckout", "true"] , processLogHandler, {}, workDir)
        await spawnProcessAsync(gitExe, ["remote",  "add", "-f",  "origin", "https://github.com/TNG/AI-Playground.git"] , processLogHandler, {}, workDir)
        await fs.promises.writeFile(spareCheckoutConfigFile, "WebUI/external/workflows/*", {encoding: 'utf-8', flag: 'w'});
    }
    logger.info(`using existing sparse checkout config`, logSourceName, true)
}
