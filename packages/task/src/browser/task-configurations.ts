/*
 * Copyright (C) 2017 Ericsson and others.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { inject, injectable, named } from 'inversify';
import { TaskOptions } from '../common/task-protocol';
import { ILogger, Disposable, DisposableCollection } from '@theia/core/lib/common/';
import URI from "@theia/core/lib/common/uri";
import { FileSystemWatcherServer, FileChange, FileChangeType } from '@theia/filesystem/lib/common/filesystem-watcher-protocol';
import { FileSystem } from '@theia/filesystem/lib/common';
import * as jsoncparser from 'jsonc-parser';
import { ParseError } from 'jsonc-parser';

export interface TaskConfigurationClient {
    /**
     * The task configuration file has changed, so a client might want to refresh its configurations
     * @returns an array of strings, each one being a task label
     */
    taskConfigurationChanged: (event: string[]) => void;
}

/**
 * Watches a tasks.json configuration file and provides a parsed version of the contained task configurations
 */
@injectable()
export class TaskConfigurations implements Disposable {

    protected readonly toDispose = new DisposableCollection();
    protected tasksMap = new Map<string, TaskOptions>();
    protected watchedConfigFileUri: string;

    /** last directory element under which we look for task config */
    protected readonly TASKFILEPATH = '.theia';
    /** task configuration file name */
    protected readonly TASKFILE = 'tasks.json';

    protected client: TaskConfigurationClient | undefined = undefined;

    constructor(
        @inject(ILogger) @named('task') protected readonly logger: ILogger,
        @inject(FileSystemWatcherServer) protected readonly watcherServer: FileSystemWatcherServer,
        @inject(FileSystem) protected readonly fileSystem: FileSystem
    ) {
        this.toDispose.push(watcherServer);

        watcherServer.setClient({
            onDidFilesChanged: async event => {
                try {
                    const watchedConfigFileChange = event.changes.find(change => change.uri === this.watchedConfigFileUri);
                    if (watchedConfigFileChange) {
                        await this.onDidTaskFileChange(watchedConfigFileChange);
                        if (this.client) {
                            this.client.taskConfigurationChanged(this.getTaskLabels());
                        }
                    }
                } catch (err) {
                    this.logger.error(err);
                }
            }
        });

        this.toDispose.push(Disposable.create(() => {
            this.tasksMap.clear();
            this.client = undefined;
        }));
    }

    setClient(client: TaskConfigurationClient) {
        this.client = client;
    }

    dispose() {
        this.toDispose.dispose();
    }

    /**
     * Triggers the watching of a potential task configuration file, under the given root URI.
     * Returns whether a configuration file was found.
     */
    async watchConfigurationFile(rootUri: string): Promise<boolean> {
        const configFile = this.getConfigFileUri(rootUri);
        if (this.watchedConfigFileUri !== configFile) {
            this.watchedConfigFileUri = configFile;
            const watchId = await this.watcherServer.watchFileChanges(configFile);
            this.toDispose.push(Disposable.create(() =>
                this.watcherServer.unwatchFileChanges(watchId))
            );
            this.refreshTasks();
        }
        if (await this.fileSystem.exists(configFile)) {
            return Promise.resolve(true);
        } else {
            this.logger.warn(`Config file ${this.TASKFILE} does not exist under ${rootUri}`);
            return Promise.resolve(false);
        }
    }

    /** returns the list of known task labels */
    getTaskLabels(): string[] {
        return [...this.tasksMap.keys()];
    }

    /** returns the task configuration for a given label */
    getTask(taskLabel: string): TaskOptions | undefined {
        if (this.tasksMap.has(taskLabel)) {
            return this.tasksMap.get(taskLabel);
        } else {
            return undefined;
        }
    }

    /** returns the string uri of where the config file would be, if it existed under a given root directory */
    protected getConfigFileUri(rootDir: string): string {
        return new URI(rootDir).resolve(this.TASKFILEPATH).resolve(this.TASKFILE).toString();
    }

    /**
     * Called when a change, to a config file we watch, is detected.
     * Triggers a reparse, if appropriate.
     */
    protected async onDidTaskFileChange(fileChange: FileChange): Promise<void> {
        if (fileChange.type === FileChangeType.DELETED) {
            this.tasksMap.clear();
        } else {
            // re-parse the config file
            this.refreshTasks();
        }
    }

    /**
     * Tries to read the tasks from a config file and if it success then updates the list of available tasks.
     * If reading a config file wasn't success then does nothing.
     */
    protected async refreshTasks() {
        const tasksOptionsArray = await this.readTasks(this.watchedConfigFileUri);
        if (tasksOptionsArray) {
            // only clear tasks map when successful at parsing the config file
            // this way we avoid clearing and re-filling it multiple times if the
            // user is editing the file in the auto-save mode, having momentarily
            // non-parsing JSON.
            this.tasksMap.clear();

            for (const task of tasksOptionsArray) {
                this.tasksMap.set(task.label, task);
            }
        }
    }

    /** parses a config file and extracts the tasks launch configurations */
    protected async readTasks(uri: string): Promise<TaskOptions[] | undefined> {
        if (!await this.fileSystem.exists(uri)) {
            return undefined;
        } else {
            try {
                const response = await this.fileSystem.resolveContent(uri);

                const strippedContent = jsoncparser.stripComments(response.content);
                const errors: ParseError[] = [];
                const tasks = jsoncparser.parse(strippedContent, errors);

                if (errors.length) {
                    for (const e of errors) {
                        this.logger.error(`Error parsing ${uri}: error: ${e.error}, length:  ${e.length}, offset:  ${e.offset}`);
                    }
                } else {
                    return this.filterDuplicates(tasks['tasks']);
                }
            } catch (err) {
                this.logger.error(`Error(s) reading config file: ${uri}`);
            }
        }
    }

    protected filterDuplicates(tasks: TaskOptions[]): TaskOptions[] {
        const filteredTasks: TaskOptions[] = [];
        for (const task of tasks) {
            if (filteredTasks.some(t => t.label === task.label)) {
                // TODO: create a problem marker so that this issue will be visible in the editor?
                this.logger.error(`Error parsing ${this.TASKFILE}: found duplicate entry for label: ${task.label}`);
            } else {
                filteredTasks.push(task);
            }
        }
        return filteredTasks;
    }
}
