// Mock 'vscode' module for unit tests running in Node.js
const mockVscode = {
  TreeItem: class TreeItem {
    label: string;
    collapsibleState: any;
    description?: string;
    contextValue?: string;
    tooltip?: string;
    iconPath?: any;
    constructor(label: string, collapsibleState: any) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: {
    None: 0,
    Collapsed: 1,
    Expanded: 2
  },
  ThemeIcon: class ThemeIcon {
    id: string;
    constructor(id: string) {
      this.id = id;
    }
  },
  EventEmitter: class EventEmitter {
    private listeners: Function[] = [];
    event = (listener: Function) => {
      this.listeners.push(listener);
    };
    fire(data: any) {
      for (const l of this.listeners) l(data);
    }
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
    getConfiguration: (section?: string) => ({
      get: (key: string, defVal?: any) => defVal,
      update: async () => {}
    }),
    openTextDocument: async () => ({}),
    showTextDocument: async () => {}
  },
  window: {
    createStatusBarItem: () => ({
      text: '',
      tooltip: '',
      show: () => {},
      hide: () => {}
    }),
    createOutputChannel: (name: string) => ({
      name,
      append: () => {},
      appendLine: () => {},
      clear: () => {},
      show: () => {},
      hide: () => {},
      dispose: () => {}
    }),
    showInformationMessage: async () => 'OK',
    showWarningMessage: async () => 'OK',
    showErrorMessage: async () => 'OK',
    showInputBox: async () => ''
  },
  commands: {
    registerCommand: () => ({ dispose: () => {} }),
    executeCommand: async () => {}
  },
  StatusBarAlignment: {
    Left: 1,
    Right: 2
  },
  ConfigurationTarget: {
    Global: 1,
    Workspace: 2,
    WorkspaceFolder: 3
  }
};

// Register mock in require cache
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (moduleName: string) {
  if (moduleName === 'vscode') {
    return mockVscode;
  }
  return originalRequire.apply(this, arguments);
};

export default mockVscode;
