/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import URI from 'vs/base/common/uri';
import * as paths from 'vs/base/common/paths';
import { TPromise } from 'vs/base/common/winjs.base';
import { dirname } from 'path';
import * as assert from 'vs/base/common/assert';
import Event, { Emitter } from 'vs/base/common/event';
import { StrictResourceMap } from 'vs/base/common/map';
import { equals } from 'vs/base/common/objects';
import { Disposable } from 'vs/base/common/lifecycle';
import { Queue } from 'vs/base/common/async';
import { stat, writeFile } from 'vs/base/node/pfs';
import { IJSONContributionRegistry, Extensions as JSONExtensions } from 'vs/platform/jsonschemas/common/jsonContributionRegistry';
import { IWorkspaceContextService, Workspace, WorkbenchState, IWorkspaceFolder, toWorkspaceFolders, IWorkspaceFoldersChangeEvent } from 'vs/platform/workspace/common/workspace';
import { FileChangesEvent } from 'vs/platform/files/common/files';
import { isLinux } from 'vs/base/common/platform';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { ConfigurationChangeEvent, ConfigurationModel, DefaultConfigurationModel } from 'vs/platform/configuration/common/configurationModels';
import { IConfigurationChangeEvent, ConfigurationTarget, IConfigurationOverrides, keyFromOverrideIdentifier, isConfigurationOverrides, IConfigurationData } from 'vs/platform/configuration/common/configuration';
import { Configuration, WorkspaceConfigurationChangeEvent, AllKeysConfigurationChangeEvent } from 'vs/workbench/services/configuration/common/configurationModels';
import { IWorkspaceConfigurationService, FOLDER_CONFIG_FOLDER_NAME, defaultSettingsSchemaId, userSettingsSchemaId, workspaceSettingsSchemaId, folderSettingsSchemaId } from 'vs/workbench/services/configuration/common/configuration';
import { Registry } from 'vs/platform/registry/common/platform';
import { IConfigurationNode, IConfigurationRegistry, Extensions, settingsSchema, resourceSettingsSchema } from 'vs/platform/configuration/common/configurationRegistry';
import { createHash } from 'crypto';
import { getWorkspaceLabel, IWorkspaceIdentifier, ISingleFolderWorkspaceIdentifier, isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier, IStoredWorkspaceFolder, isStoredWorkspaceFolder, IWorkspaceFolderCreationData } from 'vs/platform/workspaces/common/workspaces';
import { IWindowConfiguration } from 'vs/platform/windows/common/windows';
import { IExtensionService } from 'vs/platform/extensions/common/extensions';
import { ICommandService } from 'vs/platform/commands/common/commands';
import product from 'vs/platform/node/product';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ConfigurationEditingService } from 'vs/workbench/services/configuration/node/configurationEditingService';
import { WorkspaceConfiguration, FolderConfiguration } from 'vs/workbench/services/configuration/node/configuration';
import { JSONEditingService } from 'vs/workbench/services/configuration/node/jsonEditingService';
import { Schemas } from 'vs/base/common/network';
import { massageFolderPathForWorkspace } from 'vs/platform/workspaces/node/workspaces';
import { distinct } from 'vs/base/common/arrays';
import { UserConfiguration } from 'vs/platform/configuration/node/configuration';

export class WorkspaceService extends Disposable implements IWorkspaceConfigurationService, IWorkspaceContextService {

	public _serviceBrand: any;

	private workspace: Workspace;
	private _configuration: Configuration;
	private defaultConfiguration: DefaultConfigurationModel;
	private userConfiguration: UserConfiguration;
	private workspaceConfiguration: WorkspaceConfiguration;
	private cachedFolderConfigs: StrictResourceMap<FolderConfiguration>;

	private workspaceEditingQueue: Queue<void>;

	protected readonly _onDidChangeConfiguration: Emitter<IConfigurationChangeEvent> = this._register(new Emitter<IConfigurationChangeEvent>());
	public readonly onDidChangeConfiguration: Event<IConfigurationChangeEvent> = this._onDidChangeConfiguration.event;

	protected readonly _onDidChangeWorkspaceFolders: Emitter<IWorkspaceFoldersChangeEvent> = this._register(new Emitter<IWorkspaceFoldersChangeEvent>());
	public readonly onDidChangeWorkspaceFolders: Event<IWorkspaceFoldersChangeEvent> = this._onDidChangeWorkspaceFolders.event;

	protected readonly _onDidChangeWorkspaceName: Emitter<void> = this._register(new Emitter<void>());
	public readonly onDidChangeWorkspaceName: Event<void> = this._onDidChangeWorkspaceName.event;

	protected readonly _onDidChangeWorkbenchState: Emitter<WorkbenchState> = this._register(new Emitter<WorkbenchState>());
	public readonly onDidChangeWorkbenchState: Event<WorkbenchState> = this._onDidChangeWorkbenchState.event;

	private configurationEditingService: ConfigurationEditingService;
	private jsonEditingService: JSONEditingService;

	constructor(private environmentService: IEnvironmentService, private workspaceSettingsRootFolder: string = FOLDER_CONFIG_FOLDER_NAME) {
		super();

		this.defaultConfiguration = new DefaultConfigurationModel();
		this.userConfiguration = this._register(new UserConfiguration(environmentService.appSettingsPath));
		this.workspaceConfiguration = this._register(new WorkspaceConfiguration());
		this._register(this.userConfiguration.onDidChangeConfiguration(() => this.onUserConfigurationChanged()));
		this._register(this.workspaceConfiguration.onDidUpdateConfiguration(() => this.onWorkspaceConfigurationChanged()));

		this._register(Registry.as<IConfigurationRegistry>(Extensions.Configuration).onDidRegisterConfiguration(e => this.registerConfigurationSchemas()));
		this._register(Registry.as<IConfigurationRegistry>(Extensions.Configuration).onDidRegisterConfiguration(configurationProperties => this.onDefaultConfigurationChanged(configurationProperties)));

		this.workspaceEditingQueue = new Queue<void>();
	}

	// Workspace Context Service Impl

	public getWorkspace(): Workspace {
		return this.workspace;
	}

	public getWorkbenchState(): WorkbenchState {
		// Workspace has configuration file
		if (this.workspace.configuration) {
			return WorkbenchState.WORKSPACE;
		}

		// Folder has single root
		if (this.workspace.folders.length === 1) {
			return WorkbenchState.FOLDER;
		}

		// Empty
		return WorkbenchState.EMPTY;
	}

	public getWorkspaceFolder(resource: URI): IWorkspaceFolder {
		return this.workspace.getFolder(resource);
	}

	public addFolders(foldersToAdd: IWorkspaceFolderCreationData[]): TPromise<void> {
		assert.ok(this.jsonEditingService, 'Workbench is not initialized yet');
		return this.workspaceEditingQueue.queue(() => this.doAddFolders(foldersToAdd));
	}

	public removeFolders(foldersToRemove: URI[]): TPromise<void> {
		assert.ok(this.jsonEditingService, 'Workbench is not initialized yet');
		return this.workspaceEditingQueue.queue(() => this.doRemoveFolders(foldersToRemove));
	}

	public isInsideWorkspace(resource: URI): boolean {
		return !!this.getWorkspaceFolder(resource);
	}

	public isCurrentWorkspace(workspaceIdentifier: ISingleFolderWorkspaceIdentifier | IWorkspaceIdentifier): boolean {
		switch (this.getWorkbenchState()) {
			case WorkbenchState.FOLDER:
				return isSingleFolderWorkspaceIdentifier(workspaceIdentifier) && this.pathEquals(this.workspace.folders[0].uri.fsPath, workspaceIdentifier);
			case WorkbenchState.WORKSPACE:
				return isWorkspaceIdentifier(workspaceIdentifier) && this.workspace.id === workspaceIdentifier.id;
		}
		return false;
	}

	private doAddFolders(foldersToAdd: IWorkspaceFolderCreationData[]): TPromise<void> {
		if (this.getWorkbenchState() !== WorkbenchState.WORKSPACE) {
			return TPromise.as(void 0); // we need a workspace to begin with
		}

		const currentWorkspaceFolders = this.getWorkspace().folders;
		const currentWorkspaceFolderUris = currentWorkspaceFolders.map(folder => folder.uri);
		const currentStoredFolders = currentWorkspaceFolders.map(folder => folder.raw);

		const storedFoldersToAdd: IStoredWorkspaceFolder[] = [];

		const workspaceConfigFolder = dirname(this.getWorkspace().configuration.fsPath);

		foldersToAdd.forEach(folderToAdd => {
			if (this.contains(currentWorkspaceFolderUris, folderToAdd.uri)) {
				return; // already existing
			}

			let storedFolder: IStoredWorkspaceFolder;

			// File resource: use "path" property
			if (folderToAdd.uri.scheme === Schemas.file) {
				storedFolder = {
					path: massageFolderPathForWorkspace(folderToAdd.uri.fsPath, workspaceConfigFolder, currentStoredFolders)
				};
			}

			// Any other resource: use "uri" property
			else {
				storedFolder = {
					uri: folderToAdd.uri.toString(true)
				};
			}

			if (folderToAdd.name) {
				storedFolder.name = folderToAdd.name;
			}

			storedFoldersToAdd.push(storedFolder);
		});

		if (storedFoldersToAdd.length > 0) {
			return this.setFolders([...currentStoredFolders, ...storedFoldersToAdd]);
		}

		return TPromise.as(void 0);
	}

	private doRemoveFolders(foldersToRemove: URI[]): TPromise<void> {
		if (this.getWorkbenchState() !== WorkbenchState.WORKSPACE) {
			return TPromise.as(void 0); // we need a workspace to begin with
		}

		const currentWorkspaceFolders = this.getWorkspace().folders;
		const currentStoredFolders = currentWorkspaceFolders.map(folder => folder.raw);

		const newStoredFolders: IStoredWorkspaceFolder[] = currentStoredFolders.filter((folder, index) => {
			if (!isStoredWorkspaceFolder(folder)) {
				return true; // keep entries which are unrelated
			}

			return !this.contains(foldersToRemove, currentWorkspaceFolders[index].uri); // keep entries which are unrelated
		});

		if (newStoredFolders.length !== currentStoredFolders.length) {
			return this.setFolders(newStoredFolders);
		}

		return TPromise.as(void 0);
	}

	private setFolders(folders: IStoredWorkspaceFolder[]): TPromise<void> {
		return this.workspaceConfiguration.setFolders(folders, this.jsonEditingService)
			.then(() => this.onWorkspaceConfigurationChanged());
	}

	private contains(resources: URI[], toCheck: URI): boolean {
		return resources.some(resource => {
			if (isLinux) {
				return resource.toString() === toCheck.toString();
			}

			return resource.toString().toLowerCase() === toCheck.toString().toLowerCase();
		});
	}

	// Workspace Configuration Service Impl

	getConfigurationData(): IConfigurationData {
		return this._configuration.toData();
	}

	getValue<T>(): T;
	getValue<T>(section: string): T;
	getValue<T>(overrides: IConfigurationOverrides): T;
	getValue<T>(section: string, overrides: IConfigurationOverrides): T;
	getValue(arg1?: any, arg2?: any): any {
		const section = typeof arg1 === 'string' ? arg1 : void 0;
		const overrides = isConfigurationOverrides(arg1) ? arg1 : isConfigurationOverrides(arg2) ? arg2 : void 0;
		return this._configuration.getValue(section, overrides);
	}

	updateValue(key: string, value: any): TPromise<void>;
	updateValue(key: string, value: any, overrides: IConfigurationOverrides): TPromise<void>;
	updateValue(key: string, value: any, target: ConfigurationTarget): TPromise<void>;
	updateValue(key: string, value: any, overrides: IConfigurationOverrides, target: ConfigurationTarget): TPromise<void>;
	updateValue(key: string, value: any, overrides: IConfigurationOverrides, target: ConfigurationTarget, donotNotifyError: boolean): TPromise<void>;
	updateValue(key: string, value: any, arg3?: any, arg4?: any, donotNotifyError?: any): TPromise<void> {
		assert.ok(this.configurationEditingService, 'Workbench is not initialized yet');
		const overrides = isConfigurationOverrides(arg3) ? arg3 : void 0;
		const target = this.deriveConfigurationTarget(key, value, overrides, overrides ? arg4 : arg3);
		return target ? this.writeConfigurationValue(key, value, target, overrides, donotNotifyError)
			: TPromise.as(null);
	}

	reloadConfiguration(folder?: IWorkspaceFolder, key?: string): TPromise<void> {
		if (folder) {
			return this.reloadWorkspaceFolderConfiguration(folder, key);
		}
		return this.reloadUserConfiguration()
			.then(() => this.reloadWorkspaceConfiguration())
			.then(() => this.loadConfiguration());
	}

	inspect<T>(key: string, overrides?: IConfigurationOverrides): {
		default: T,
		user: T,
		workspace: T,
		workspaceFolder: T,
		memory?: T,
		value: T
	} {
		return this._configuration.lookup<T>(key);
	}

	keys(): {
		default: string[];
		user: string[];
		workspace: string[];
		workspaceFolder: string[];
	} {
		return this._configuration.keys();
	}

	getUnsupportedWorkspaceKeys(): string[] {
		const unsupportedWorkspaceKeys = [...this.workspaceConfiguration.getWorkspaceSettings().unsupportedKeys];
		for (const folder of this.workspace.folders) {
			unsupportedWorkspaceKeys.push(...this.cachedFolderConfigs.get(folder.uri).getUnsupportedKeys());
		}
		return distinct(unsupportedWorkspaceKeys);
	}

	initialize(arg: IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier | IWindowConfiguration): TPromise<any> {
		return this.createWorkspace(arg)
			.then(workspace => this.updateWorkspaceAndInitializeConfiguration(workspace));
	}

	setInstantiationService(instantiationService: IInstantiationService): void {
		this.configurationEditingService = instantiationService.createInstance(ConfigurationEditingService);
		this.jsonEditingService = instantiationService.createInstance(JSONEditingService);
	}

	handleWorkspaceFileEvents(event: FileChangesEvent): TPromise<void> {
		switch (this.getWorkbenchState()) {
			case WorkbenchState.FOLDER:
				return this.onSingleFolderFileChanges(event);
			case WorkbenchState.WORKSPACE:
				return this.onWorkspaceFileChanges(event);
		}
		return TPromise.as(void 0);
	}

	private createWorkspace(arg: IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier | IWindowConfiguration): TPromise<Workspace> {
		if (isWorkspaceIdentifier(arg)) {
			return this.createMulitFolderWorkspace(arg);
		}

		if (isSingleFolderWorkspaceIdentifier(arg)) {
			return this.createSingleFolderWorkspace(arg);
		}

		return this.createEmptyWorkspace(arg);
	}

	private createMulitFolderWorkspace(workspaceIdentifier: IWorkspaceIdentifier): TPromise<Workspace> {
		const workspaceConfigPath = URI.file(workspaceIdentifier.configPath);
		return this.workspaceConfiguration.load(workspaceConfigPath)
			.then(() => {
				const workspaceFolders = toWorkspaceFolders(this.workspaceConfiguration.getFolders(), URI.file(paths.dirname(workspaceConfigPath.fsPath)));
				const workspaceId = workspaceIdentifier.id;
				const workspaceName = getWorkspaceLabel({ id: workspaceId, configPath: workspaceConfigPath.fsPath }, this.environmentService);
				return new Workspace(workspaceId, workspaceName, workspaceFolders, workspaceConfigPath);
			});
	}

	private createSingleFolderWorkspace(singleFolderWorkspaceIdentifier: ISingleFolderWorkspaceIdentifier): TPromise<Workspace> {
		const folderPath = URI.file(singleFolderWorkspaceIdentifier);
		return stat(folderPath.fsPath)
			.then(workspaceStat => {
				const ctime = isLinux ? workspaceStat.ino : workspaceStat.birthtime.getTime(); // On Linux, birthtime is ctime, so we cannot use it! We use the ino instead!
				const id = createHash('md5').update(folderPath.fsPath).update(ctime ? String(ctime) : '').digest('hex');
				const folder = URI.file(folderPath.fsPath);
				return new Workspace(id, paths.basename(folderPath.fsPath), toWorkspaceFolders([{ path: folder.fsPath }]), null, ctime);
			});
	}

	private createEmptyWorkspace(configuration: IWindowConfiguration): TPromise<Workspace> {
		let id = configuration.backupPath ? URI.from({ path: paths.basename(configuration.backupPath), scheme: 'empty' }).toString() : '';
		return TPromise.as(new Workspace(id));
	}

	private updateWorkspaceAndInitializeConfiguration(workspace: Workspace): TPromise<void> {
		let folderChanges: IWorkspaceFoldersChangeEvent;
		if (this.workspace) {
			const currentState = this.getWorkbenchState();
			const currentWorkspacePath = this.workspace.configuration ? this.workspace.configuration.fsPath : void 0;
			const currentFolders = this.workspace.folders;

			this.workspace.update(workspace);

			const newState = this.getWorkbenchState();
			if (newState !== currentState) {
				this._onDidChangeWorkbenchState.fire(newState);
			}

			const newWorkspacePath = this.workspace.configuration ? this.workspace.configuration.fsPath : void 0;
			if (newWorkspacePath !== currentWorkspacePath || newState !== currentState) {
				this._onDidChangeWorkspaceName.fire();
			}

			folderChanges = this.compareFolders(currentFolders, this.workspace.folders);

		} else {
			this.workspace = workspace;
		}

		return this.initializeConfiguration().then(() => {
			// Trigger folders change after configuration initialization so that configuration is up to date.
			if (folderChanges && (folderChanges.added.length || folderChanges.removed.length || folderChanges.changed.length)) {
				this._onDidChangeWorkspaceFolders.fire(folderChanges);
			}
		});
	}

	private compareFolders(currentFolders: IWorkspaceFolder[], newFolders: IWorkspaceFolder[]): IWorkspaceFoldersChangeEvent {
		const result = { added: [], removed: [], changed: [] };
		result.added = newFolders.filter(newFolder => !currentFolders.some(currentFolder => newFolder.uri.toString() === currentFolder.uri.toString()));
		for (let currentIndex = 0; currentIndex < currentFolders.length; currentIndex++) {
			let currentFolder = currentFolders[currentIndex];
			let newIndex = 0;
			for (newIndex = 0; newIndex < newFolders.length && currentFolder.uri.toString() !== newFolders[newIndex].uri.toString(); newIndex++) { }
			if (newIndex < newFolders.length) {
				if (currentIndex !== newIndex || currentFolder.name !== newFolders[newIndex].name) {
					result.changed.push(currentFolder);
				}
			} else {
				result.removed.push(currentFolder);
			}
		}
		return result;
	}

	private initializeConfiguration(): TPromise<void> {
		this.registerConfigurationSchemas();
		return this.loadConfiguration();
	}

	private reloadUserConfiguration(key?: string): TPromise<void> {
		return this.userConfiguration.reload();
	}

	private reloadWorkspaceConfiguration(key?: string): TPromise<void> {
		const workbenchState = this.getWorkbenchState();
		if (workbenchState === WorkbenchState.FOLDER) {
			return this.onWorkspaceFolderConfigurationChanged(this.workspace.folders[0], key);
		}
		if (workbenchState === WorkbenchState.WORKSPACE) {
			return this.workspaceConfiguration.reload().then(() => this.onWorkspaceConfigurationChanged());
		}
		return TPromise.as(null);
	}

	private reloadWorkspaceFolderConfiguration(folder: IWorkspaceFolder, key?: string): TPromise<void> {
		return this.onWorkspaceFolderConfigurationChanged(folder, key);
	}

	private loadConfiguration(): TPromise<void> {
		// reset caches
		this.cachedFolderConfigs = new StrictResourceMap<FolderConfiguration>();

		const folders = this.workspace.folders;
		return this.loadFolderConfigurations(folders)
			.then((folderConfigurations) => {

				let workspaceConfiguration = this.getWorkspaceConfigurationModel(folderConfigurations);
				const folderConfigurationModels = new StrictResourceMap<ConfigurationModel>();
				folderConfigurations.forEach((folderConfiguration, index) => folderConfigurationModels.set(folders[index].uri, folderConfiguration));

				const currentConfiguration = this._configuration;
				this._configuration = new Configuration(this.defaultConfiguration, this.userConfiguration.configurationModel, workspaceConfiguration, folderConfigurationModels, new ConfigurationModel(), new StrictResourceMap<ConfigurationModel>(), this.getWorkbenchState() !== WorkbenchState.EMPTY ? this.workspace : null); //TODO: Sandy Avoid passing null

				if (currentConfiguration) {
					const changedKeys = this._configuration.compare(currentConfiguration);
					this.triggerConfigurationChange(new ConfigurationChangeEvent().change(changedKeys), ConfigurationTarget.WORKSPACE);
				} else {
					this._onDidChangeConfiguration.fire(new AllKeysConfigurationChangeEvent(this._configuration, ConfigurationTarget.WORKSPACE, this.getTargetConfiguration(ConfigurationTarget.WORKSPACE)));
				}
			});
	}

	private getWorkspaceConfigurationModel(folderConfigurations: ConfigurationModel[]): ConfigurationModel {
		switch (this.getWorkbenchState()) {
			case WorkbenchState.FOLDER:
				return folderConfigurations[0];
			case WorkbenchState.WORKSPACE:
				return this.workspaceConfiguration.getConfiguration();
			default:
				return new ConfigurationModel();
		}
	}

	private onDefaultConfigurationChanged(keys: string[]): void {
		this.defaultConfiguration = new DefaultConfigurationModel();
		this.registerConfigurationSchemas();
		if (this.workspace && this._configuration) {
			this._configuration.updateDefaultConfiguration(this.defaultConfiguration);
			this._configuration.updateWorkspaceConfiguration(this.workspaceConfiguration.reprocessWorkspaceSettings());
			this.workspace.folders.forEach(folder => this._configuration.updateFolderConfiguration(folder.uri, this.cachedFolderConfigs.get(folder.uri).reprocess()));
			this.triggerConfigurationChange(new ConfigurationChangeEvent().change(keys), ConfigurationTarget.DEFAULT);
		}
	}

	private registerConfigurationSchemas(): void {
		if (this.workspace) {
			const jsonRegistry = Registry.as<IJSONContributionRegistry>(JSONExtensions.JSONContribution);
			jsonRegistry.registerSchema(defaultSettingsSchemaId, settingsSchema);
			jsonRegistry.registerSchema(userSettingsSchemaId, settingsSchema);

			if (WorkbenchState.WORKSPACE === this.getWorkbenchState()) {
				jsonRegistry.registerSchema(workspaceSettingsSchemaId, settingsSchema);
				jsonRegistry.registerSchema(folderSettingsSchemaId, resourceSettingsSchema);
			} else {
				jsonRegistry.registerSchema(workspaceSettingsSchemaId, settingsSchema);
				jsonRegistry.registerSchema(folderSettingsSchemaId, settingsSchema);
			}
		}
	}

	private onUserConfigurationChanged(): void {
		let keys = this._configuration.compareAndUpdateUserConfiguration(this.userConfiguration.configurationModel);
		this.triggerConfigurationChange(keys, ConfigurationTarget.USER);
	}

	private onWorkspaceConfigurationChanged(): TPromise<void> {
		if (this.workspace && this.workspace.configuration && this._configuration) {
			const workspaceConfigurationChangeEvent = this._configuration.compareAndUpdateWorkspaceConfiguration(this.workspaceConfiguration.getConfiguration());
			let configuredFolders = toWorkspaceFolders(this.workspaceConfiguration.getFolders(), URI.file(paths.dirname(this.workspace.configuration.fsPath)));
			const changes = this.compareFolders(this.workspace.folders, configuredFolders);
			if (changes.added.length || changes.removed.length || changes.changed.length) {
				this.workspace.folders = configuredFolders;
				return this.onFoldersChanged()
					.then(foldersConfigurationChangeEvent => {
						this.triggerConfigurationChange(foldersConfigurationChangeEvent.change(workspaceConfigurationChangeEvent), ConfigurationTarget.WORKSPACE_FOLDER);
						this._onDidChangeWorkspaceFolders.fire(changes);
					});
			} else {
				this.triggerConfigurationChange(workspaceConfigurationChangeEvent, ConfigurationTarget.WORKSPACE);
			}
		}
		return TPromise.as(null);
	}

	private onWorkspaceFileChanges(event: FileChangesEvent): TPromise<void> {
		return TPromise.join(this.workspace.folders.map(folder =>
			// handle file event for each folder
			this.cachedFolderConfigs.get(folder.uri).handleWorkspaceFileEvents(event)
				// Update folder configuration if handled
				.then(folderConfiguration => folderConfiguration ? this._configuration.compareAndUpdateFolderConfiguration(folder.uri, folderConfiguration) : new ConfigurationChangeEvent()))
		).then(changeEvents => {
			const consolidateChangeEvent = changeEvents.reduce((consolidated, e) => consolidated.change(e), new ConfigurationChangeEvent());
			this.triggerConfigurationChange(consolidateChangeEvent, ConfigurationTarget.WORKSPACE_FOLDER);
		});
	}

	private onSingleFolderFileChanges(event: FileChangesEvent): TPromise<void> {
		const folder = this.workspace.folders[0];
		return this.cachedFolderConfigs.get(folder.uri).handleWorkspaceFileEvents(event)
			.then(folderConfiguration => {
				if (folderConfiguration) {
					// File change handled
					this._configuration.compareAndUpdateFolderConfiguration(folder.uri, folderConfiguration);
					const workspaceChangedKeys = this._configuration.compareAndUpdateWorkspaceConfiguration(folderConfiguration);
					this.triggerConfigurationChange(workspaceChangedKeys, ConfigurationTarget.WORKSPACE);
				}
			});
	}

	private onWorkspaceFolderConfigurationChanged(folder: IWorkspaceFolder, key?: string): TPromise<void> {
		this.disposeFolderConfiguration(folder);
		return this.loadFolderConfigurations([folder])
			.then(([folderConfiguration]) => {
				const folderChangedKeys = this._configuration.compareAndUpdateFolderConfiguration(folder.uri, folderConfiguration);
				if (this.getWorkbenchState() === WorkbenchState.FOLDER) {
					const workspaceChangedKeys = this._configuration.compareAndUpdateWorkspaceConfiguration(folderConfiguration);
					this.triggerConfigurationChange(workspaceChangedKeys, ConfigurationTarget.WORKSPACE);
				} else {
					this.triggerConfigurationChange(folderChangedKeys, ConfigurationTarget.WORKSPACE_FOLDER);
				}
			});
	}

	private onFoldersChanged(): TPromise<ConfigurationChangeEvent> {
		let changeEvent = new ConfigurationChangeEvent();

		// Remove the configurations of deleted folders
		for (const key of this.cachedFolderConfigs.keys()) {
			if (!this.workspace.folders.filter(folder => folder.uri.toString() === key.toString())[0]) {
				this.cachedFolderConfigs.delete(key);
				changeEvent = changeEvent.change(this._configuration.compareAndDeleteFolderConfiguration(key));
			}
		}

		const toInitialize = this.workspace.folders.filter(folder => !this.cachedFolderConfigs.has(folder.uri));
		if (toInitialize.length) {
			return this.loadFolderConfigurations(toInitialize)
				.then(folderConfigurations => {
					folderConfigurations.forEach((folderConfiguration, index) => {
						changeEvent = changeEvent.change(this._configuration.compareAndUpdateFolderConfiguration(toInitialize[index].uri, folderConfiguration));
					});
					return changeEvent;
				});
		}
		return TPromise.as(changeEvent);
	}

	private loadFolderConfigurations(folders: IWorkspaceFolder[]): TPromise<ConfigurationModel[]> {
		return TPromise.join([...folders.map(folder => {
			const folderConfiguration = new FolderConfiguration(folder.uri, this.workspaceSettingsRootFolder, this.getWorkbenchState());
			this.cachedFolderConfigs.set(folder.uri, this._register(folderConfiguration));
			return folderConfiguration.loadConfiguration();
		})]);
	}

	private writeConfigurationValue(key: string, value: any, target: ConfigurationTarget, overrides: IConfigurationOverrides, donotNotifyError: boolean): TPromise<void> {
		if (target === ConfigurationTarget.DEFAULT) {
			return TPromise.wrapError(new Error('Invalid configuration target'));
		}

		if (target === ConfigurationTarget.MEMORY) {
			this._configuration.updateValue(key, value, overrides);
			this.triggerConfigurationChange(new ConfigurationChangeEvent().change(overrides.overrideIdentifier ? [keyFromOverrideIdentifier(overrides.overrideIdentifier)] : [key], overrides.resource), target);
			return TPromise.as(null);
		}

		return this.configurationEditingService.writeConfiguration(target, { key, value }, { scopes: overrides, donotNotifyError })
			.then(() => {
				switch (target) {
					case ConfigurationTarget.USER:
						return this.reloadUserConfiguration();
					case ConfigurationTarget.WORKSPACE:
						return this.reloadWorkspaceConfiguration();
					case ConfigurationTarget.WORKSPACE_FOLDER:
						const workspaceFolder = overrides && overrides.resource ? this.workspace.getFolder(overrides.resource) : null;
						if (workspaceFolder) {
							return this.reloadWorkspaceFolderConfiguration(this.workspace.getFolder(overrides.resource), key);
						}
				}
				return null;
			});
	}

	private deriveConfigurationTarget(key: string, value: any, overrides: IConfigurationOverrides, target: ConfigurationTarget): ConfigurationTarget {
		if (target) {
			return target;
		}

		if (value === void 0) {
			// Ignore. But expected is to remove the value from all targets
			return void 0;
		}

		const inspect = this.inspect(key, overrides);
		if (equals(value, inspect.value)) {
			// No change. So ignore.
			return void 0;
		}

		if (inspect.workspaceFolder !== void 0) {
			return ConfigurationTarget.WORKSPACE_FOLDER;
		}

		if (inspect.workspace !== void 0) {
			return ConfigurationTarget.WORKSPACE;
		}

		return ConfigurationTarget.USER;
	}

	private triggerConfigurationChange(configurationEvent: ConfigurationChangeEvent, target: ConfigurationTarget): void {
		if (configurationEvent.affectedKeys.length) {
			configurationEvent.telemetryData(target, this.getTargetConfiguration(target));
			this._onDidChangeConfiguration.fire(new WorkspaceConfigurationChangeEvent(configurationEvent, this.workspace));
		}
	}

	private getTargetConfiguration(target: ConfigurationTarget): any {
		switch (target) {
			case ConfigurationTarget.DEFAULT:
				return this._configuration.defaults.contents;
			case ConfigurationTarget.USER:
				return this._configuration.user.contents;
			case ConfigurationTarget.WORKSPACE:
				return this._configuration.workspace.contents;
		}
		return {};
	}

	private pathEquals(path1: string, path2: string): boolean {
		if (!isLinux) {
			path1 = path1.toLowerCase();
			path2 = path2.toLowerCase();
		}

		return path1 === path2;
	}

	private disposeFolderConfiguration(folder: IWorkspaceFolder): void {
		const folderConfiguration = this.cachedFolderConfigs.get(folder.uri);
		if (folderConfiguration) {
			folderConfiguration.dispose();
		}
	}
}

interface IExportedConfigurationNode {
	name: string;
	description: string;
	default: any;
	type: string | string[];
	enum?: any[];
	enumDescriptions?: string[];
}

interface IConfigurationExport {
	settings: IExportedConfigurationNode[];
	buildTime: number;
	commit: string;
	buildNumber: number;
}

export class DefaultConfigurationExportHelper {

	constructor(
		@IEnvironmentService environmentService: IEnvironmentService,
		@IExtensionService private extensionService: IExtensionService,
		@ICommandService private commandService: ICommandService) {
		if (environmentService.args['export-default-configuration']) {
			this.writeConfigModelAndQuit(environmentService.args['export-default-configuration']);
		}
	}

	private writeConfigModelAndQuit(targetPath: string): TPromise<void> {
		return this.extensionService.onReady()
			.then(() => this.writeConfigModel(targetPath))
			.then(() => this.commandService.executeCommand('workbench.action.quit'))
			.then(() => { });
	}

	private writeConfigModel(targetPath: string): TPromise<void> {
		const config = this.getConfigModel();

		const resultString = JSON.stringify(config, undefined, '  ');
		return writeFile(targetPath, resultString);
	}

	private getConfigModel(): IConfigurationExport {
		const configurations = Registry.as<IConfigurationRegistry>(Extensions.Configuration).getConfigurations().slice();
		const settings: IExportedConfigurationNode[] = [];
		const processConfig = (config: IConfigurationNode) => {
			if (config.properties) {
				for (let name in config.properties) {
					const prop = config.properties[name];
					const propDetails: IExportedConfigurationNode = {
						name,
						description: prop.description,
						default: prop.default,
						type: prop.type
					};

					if (prop.enum) {
						propDetails.enum = prop.enum;
					}

					if (prop.enumDescriptions) {
						propDetails.enumDescriptions = prop.enumDescriptions;
					}

					settings.push(propDetails);
				}
			}

			if (config.allOf) {
				config.allOf.forEach(processConfig);
			}
		};

		configurations.forEach(processConfig);

		const result: IConfigurationExport = {
			settings: settings.sort((a, b) => a.name.localeCompare(b.name)),
			buildTime: Date.now(),
			commit: product.commit,
			buildNumber: product.settingsSearchBuildId
		};

		return result;
	}
}
