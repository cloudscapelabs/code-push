import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import slash = require("slash");
import * as recursiveFs from "recursive-fs";
import * as yazl from "yazl";
import Adapter from "../utils/adapter/adapter"
import RequestManager from "../utils/request-manager"
import { CodePushUnauthorizedError } from "./code-push-error"
import FileUploadClient, { IProgress } from "appcenter-file-upload-client";

import { AccessKey, AccessKeyRequest, Account, App, AppCreationRequest, CollaboratorMap, Deployment, DeploymentMetrics, Headers, Package, PackageInfo, ReleaseUploadAssets, UploadReleaseProperties, CodePushError, ServerAccessKey, Session } from "./types";

interface JsonResponse {
    headers: Headers;
    body?: any;
}

interface PackageFile {
    isTemporary: boolean;
    path: string;
}

// A template string tag function that URL encodes the substituted values
function urlEncode(strings: TemplateStringsArray, ...values: string[]): string {
    var result = "";
    for (var i = 0; i < strings.length; i++) {
        result += strings[i];
        if (i < values.length) {
            result += encodeURIComponent(values[i]);
        }
    }

    return result;
}

class AccountManager {
    public static AppPermission = {
        OWNER: "Owner",
        COLLABORATOR: "Collaborator"
    };

    private _accessKey: string;
    private _requestManager: RequestManager;
    private _adapter: Adapter;
    private _fileUploadClient: FileUploadClient;

    constructor(accessKey: string, customHeaders?: Headers, serverUrl?: string, proxy?: string) {
        if (!accessKey) throw new CodePushUnauthorizedError("A token must be specified.");

        this._accessKey = accessKey;
        this._requestManager = new RequestManager(accessKey, customHeaders, serverUrl, proxy);
        this._adapter = new Adapter(this._requestManager);
        this._fileUploadClient = new FileUploadClient();
    }

    public get accessKey(): string {
        return this._accessKey;
    }

    public async isAuthenticated(throwIfUnauthorized?: boolean): Promise<boolean> {
        let res: JsonResponse;
        let codePushError: CodePushError;

        try {
            res = await this._requestManager.get(urlEncode`/authenticated`, false);
        } catch (error) {
            codePushError = error as CodePushError;
            if (codePushError && (codePushError.statusCode !== RequestManager.ERROR_UNAUTHORIZED || throwIfUnauthorized)) {
                throw codePushError;
            }
        }

        const authenticated: boolean = !!res && !!res.body;

        return authenticated;
    }

    // Access keys
    public async addAccessKey(friendlyName: string, ttl?: number): Promise<AccessKey> {
        if (!friendlyName) {
            throw new CodePushUnauthorizedError("A name must be specified when adding an access key.");
        }

        const accessKeyRequest: AccessKeyRequest = {
            createdBy: os.hostname(),
            friendlyName,
            ttl
        };

        const res: JsonResponse = await this._requestManager.post(urlEncode`/accessKeys`, JSON.stringify(accessKeyRequest), /*expectResponseBody=*/ true);
        return {
            createdTime: res.body.accessKey.createdTime,
            expires: res.body.accessKey.expires,
            key: res.body.accessKey.name,
            name: res.body.accessKey.friendlyName
        };
    }

    public async getAccessKey(accessKeyName: string): Promise<AccessKey> {
        const res: JsonResponse = await this._requestManager.get(urlEncode`/accessKeys/${accessKeyName}`);

        return {
            createdTime: res.body.accessKey.createdTime,
            expires: res.body.accessKey.expires,
            name: res.body.accessKey.friendlyName,
        };
    }

    public async getAccessKeys(): Promise<AccessKey[]> {
        const res: JsonResponse = await this._requestManager.get(urlEncode`/accessKeys`);

        const accessKeys: AccessKey[] = [];
        res.body.accessKeys.forEach((serverAccessKey: ServerAccessKey) => {
            !serverAccessKey.isSession && accessKeys.push({
                createdTime: serverAccessKey.createdTime,
                expires: serverAccessKey.expires,
                name: serverAccessKey.friendlyName
            });
        });

        return accessKeys;
    }

    public async patchAccessKey(oldName: string, newName?: string, ttl?: number): Promise<AccessKey> {
        var accessKeyRequest: AccessKeyRequest = {
            friendlyName: newName,
            ttl
        };

        const res: JsonResponse = await this._requestManager.patch(urlEncode`/accessKeys/${oldName}`, JSON.stringify(accessKeyRequest));

        return {
            createdTime: res.body.accessKey.createdTime,
            expires: res.body.accessKey.expires,
            name: res.body.accessKey.friendlyName,
        };
    }

    public async getSessions(): Promise<Session[]> {
        const res = await this._requestManager.get(urlEncode`/accessKeys`)

        // A machine name might be associated with multiple session keys,
        // but we should only return one per machine name.
        const sessionMap: { [machineName: string]: Session } = {};
        const now: number = new Date().getTime();
        res.body.accessKeys.forEach((serverAccessKey: ServerAccessKey) => {
            if (serverAccessKey.isSession && serverAccessKey.expires > now) {
                sessionMap[serverAccessKey.createdBy] = {
                    loggedInTime: serverAccessKey.createdTime,
                    machineName: serverAccessKey.createdBy
                };
            }
        });

        const sessions: Session[] = Object.keys(sessionMap)
            .map((machineName: string) => sessionMap[machineName]);

        return sessions;
    }

    public async removeAccessKey(name: string): Promise<void> {
        await this._requestManager.del(urlEncode`/accessKeys/${name}`);
        return null;
    }

    public async removeSession(machineName: string): Promise<void> {
        await this._requestManager.del(urlEncode`/accessKeys/${machineName}`);
        return null
    }

    // Account
    public async getAccountInfo(): Promise<Account> {
        const res: JsonResponse = await this._requestManager.get(urlEncode`/account`);
        return res.body.account;
    }

    // Apps
    public async getApps(): Promise<App[]> {
        const res: JsonResponse = await this._requestManager.get(urlEncode`/apps`);
        return res.body.apps;
    }

    public async getApp(appName: string): Promise<App> {
        const res: JsonResponse = await this._requestManager.get(urlEncode`/apps/${appName}`);
        return res.body.app;
    }

    public async addApp(appName: string, appOs: string, appPlatform: string, manuallyProvisionDeployments: boolean = false): Promise<App> {
        const app: AppCreationRequest = {
            name: appName,
            os: appOs,
            platform: appPlatform,
            manuallyProvisionDeployments: manuallyProvisionDeployments
        };

        await this._requestManager.post(urlEncode`/apps/`, JSON.stringify(app), false);

        return app
    }

    public async removeApp(appName: string): Promise<void> {
        await this._requestManager.del(urlEncode`/apps/${appName}`);
        return null;
    }

    public async renameApp(oldAppName: string, newAppName: string): Promise<void> {
        const body = { name: newAppName }

        await this._requestManager.patch(urlEncode`/apps/${oldAppName}`, JSON.stringify(body));
        return null;
    }

    public async transferApp(appName: string, orgName: string): Promise<void> {
        await this._requestManager.post(urlEncode`/apps/${appName}/transfer/${orgName}`, /*requestBody=*/ null, /*expectResponseBody=*/ false);
        return null;
    }

    // Collaborators
    public async getCollaborators(appName: string): Promise<CollaboratorMap> {
        const res: JsonResponse = await this._requestManager.get(urlEncode`/apps/${appName}/collaborators`);
        return res.body.collaborators;
    }

    public async addCollaborator(appName: string, email: string): Promise<void> {
        await this._requestManager.post(urlEncode`/apps/${appName}/collaborators/${email}`, null, /*expectResponseBody=*/ false);
        return null;
    }

    public async removeCollaborator(appName: string, email: string): Promise<void> {
        await this._requestManager.del(urlEncode`/apps/${appName}/collaborators/${email}`);
        return null;
    }

    // Deployments
    public async addDeployment(appName: string, deploymentName: string): Promise<Deployment> {
        const deployment = <Deployment>{ name: deploymentName };
        const res = await this._requestManager.post(urlEncode`/apps/${appName}/deployments/`, JSON.stringify(deployment), /*expectResponseBody=*/ true);

        return res.body.deployment;
    }

    public async clearDeploymentHistory(appName: string, deploymentName: string): Promise<void> {
        await this._requestManager.del(urlEncode`/apps/${appName}/deployments/${deploymentName}/releases`);
        return null;
    }

    public async getDeployments(appName: string): Promise<Deployment[]> {
        const res: JsonResponse = await this._requestManager.get(urlEncode`/apps/${appName}/deployments/`);

        return res.body.deployment;
    }

    public async getDeployment(appName: string, deploymentName: string): Promise<Deployment> {
        const res: JsonResponse = await this._requestManager.get(urlEncode`/apps/${appName}/deployments/${deploymentName}`);

        return res.body.deployment;
    }

    public async renameDeployment(appName: string, oldDeploymentName: string, newDeploymentName: string): Promise<void> {
        await this._requestManager.patch(urlEncode`/apps/${appName}/deployments/${oldDeploymentName}`, JSON.stringify({ name: newDeploymentName }));

        return null;
    }

    public async removeDeployment(appName: string, deploymentName: string): Promise<void> {
        await this._requestManager.del(urlEncode`/apps/${appName}/deployments/${deploymentName}`);

        return null;
    }

    public async getDeploymentMetrics(appName: string, deploymentName: string): Promise<DeploymentMetrics> {
        const res = await this._requestManager.get(urlEncode`/apps/${appName}/deployments/${deploymentName}/metrics`);

        return res.body.metrics;
    }

    public async getDeploymentHistory(appName: string, deploymentName: string): Promise<Package[]> {
        const res = await this._requestManager.get(urlEncode`/apps/${appName}/deployments/${deploymentName}/history`);

        return res.body.history;
    }

    // Releases
    public async release(appName: string, deploymentName: string, filePath: string, targetBinaryVersion: string, updateMetadata: PackageInfo, uploadProgressCallback?: (progress: number) => void): Promise<Package> {
        updateMetadata.appVersion = targetBinaryVersion;
        const packageFile: PackageFile = await this.packageFileFromPath(filePath);

        const request = this._requestManager.getRequest('post', urlEncode`/apps/${appName}/deployments/${deploymentName}/release`)

        const file = fs.createReadStream(packageFile.path);
        const response = await request.attach('package', file)
        .field('packageInfo', JSON.stringify(updateMetadata))
        .on('progress', (event: any) => {
            if (uploadProgressCallback && event && event.total > 0) {
                var currentProgress: number = event.loaded / event.total * 100;
                uploadProgressCallback(currentProgress);
            }
        })

        const body = JSON.parse(response.text);
        if (response.ok) {
            return body.package;
        } else {
            throw new Error(body.message);
        }
    }

    public async patchRelease(appName: string, deploymentName: string, label: string, updateMetadata: PackageInfo): Promise<void> {
        updateMetadata.label = label;
        const requestBody = { packageInfo: updateMetadata }

        await this._requestManager.patch(urlEncode`/apps/${appName}/deployments/${deploymentName}/release`, JSON.stringify(requestBody), /*expectResponseBody=*/ false)
        return null;
    }

    public async promote(appName: string, sourceDeploymentName: string, destinationDeploymentName: string, updateMetadata: PackageInfo): Promise<Package> {
        const requestBody = { packageInfo: updateMetadata };
        const res = await this._requestManager.post(urlEncode`/apps/${appName}/deployments/${sourceDeploymentName}/promote/${destinationDeploymentName}`, JSON.stringify(requestBody), /*expectResponseBody=*/ true);

        return res.body.package;
    }

    public async rollback(appName: string, deploymentName: string, targetRelease?: string): Promise<void> {
        const requestBody = targetRelease ? {
            label: targetRelease
        } : {};

        await this._requestManager.post(urlEncode`/apps/${appName}/deployments/${deploymentName}/rollback`, JSON.stringify(requestBody), /*expectResponseBody=*/ false);
        return null;
    }

    private packageFileFromPath(filePath: string): Promise<PackageFile> {
        var getPackageFilePromise: Promise<PackageFile>;
        if (fs.lstatSync(filePath).isDirectory()) {
            getPackageFilePromise = new Promise<PackageFile>((resolve: (file: PackageFile) => void, reject: (reason: Error) => void): void => {
                var directoryPath: string = filePath;

                recursiveFs.readdirr(directoryPath, (error?: any, directories?: string[], files?: string[]): void => {
                    if (error) {
                        reject(error);
                        return;
                    }

                    var baseDirectoryPath = path.dirname(directoryPath);
                    var fileName: string = this.generateRandomFilename(15) + ".zip";
                    var zipFile = new yazl.ZipFile();
                    var writeStream: fs.WriteStream = fs.createWriteStream(fileName);

                    zipFile.outputStream.pipe(writeStream)
                        .on("error", (error: Error): void => {
                            reject(error);
                        })
                        .on("close", (): void => {
                            filePath = path.join(process.cwd(), fileName);

                            resolve({ isTemporary: true, path: filePath });
                        });

                    for (var i = 0; i < files.length; ++i) {
                        var file: string = files[i];
                        var relativePath: string = path.relative(baseDirectoryPath, file);

                        // yazl does not like backslash (\) in the metadata path.
                        relativePath = slash(relativePath);

                        zipFile.addFile(file, relativePath);
                    }

                    zipFile.end();
                });
            });
        } else {
            getPackageFilePromise = new Promise<PackageFile>((resolve: (file: PackageFile) => void, reject: (reason: Error) => void): void => {
                resolve({ isTemporary: false, path: filePath });
            });
        }
        return getPackageFilePromise;
    }

    private generateRandomFilename(length: number): string {
        var filename: string = "";
        var validChar: string = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

        for (var i = 0; i < length; i++) {
            filename += validChar.charAt(Math.floor(Math.random() * validChar.length));
        }

        return filename;
    }

    private getDeprecatedMethodError() {
        return {
            message: 'Method is deprecated',
            statusCode: 404
        };
    }
}

export = AccountManager;
