import {ChildProcess} from "node:child_process";
import path from "node:path";
import {app, BrowserWindow} from "electron";
import {appLoggerInstance} from "../logging/logger.ts";
import fs from "fs";
import * as filesystem from "fs-extra";
