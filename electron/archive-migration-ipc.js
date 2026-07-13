const { ipcMain } = require("electron");

class ArchiveMigrationIpcController {
  constructor(migration) {
    this.migration = migration;
  }

  register() {
    ipcMain.handle("migration:inspect", (_event, input) => this.migration.inspect(input));
    ipcMain.handle("migration:start", (_event, input) => this.migration.start(input));
    ipcMain.handle("migration:pause", () => this.migration.pause());
    ipcMain.handle("migration:resume", () => this.migration.resume());
    ipcMain.handle("migration:status", () => this.migration.getStatus());
    ipcMain.handle("migration:index", () => this.migration.index());
    ipcMain.handle("migration:forget", () => this.migration.forget());
  }
}

module.exports = { ArchiveMigrationIpcController };
