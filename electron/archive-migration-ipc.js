const { ipcMain } = require("electron");

class ArchiveMigrationIpcController {
  constructor(migration, ipc = ipcMain) {
    this.migration = migration;
    this.ipcMain = ipc;
  }

  register() {
    this.ipcMain.handle("migration:inspect", (_event, input) => this.migration.inspect(input));
    this.ipcMain.handle("migration:start", (_event, input) => this.migration.start(input));
    this.ipcMain.handle("migration:pause", () => this.migration.pause());
    this.ipcMain.handle("migration:resume", () => this.migration.resume());
    this.ipcMain.handle("migration:status", () => this.migration.getStatus());
    this.ipcMain.handle("migration:index", () => this.migration.index());
    this.ipcMain.handle("migration:forget", () => this.migration.forget());
  }
}

module.exports = { ArchiveMigrationIpcController };
