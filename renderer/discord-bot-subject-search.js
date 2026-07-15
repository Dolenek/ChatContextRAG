window.discordBotSubjectSearch = (() => {
  class DiscordBotSubjectSearch {
    constructor(options) {
      this.root = options.root;
      this.showToast = options.showToast;
      this.getGuild = options.getGuild;
      this.getRoles = options.getRoles;
      this.getSubjects = options.getSubjects;
      this.onAdd = options.onAdd;
      this.timers = new Map();
      this.revisions = new Map();
    }

    bind() {
      this.root.querySelectorAll("[data-subject-search]").forEach((button) => {
        button.addEventListener("click", () => void this.search(button.dataset.subjectSearch));
      });
      this.root.querySelectorAll("[data-subject-query]").forEach((input) => {
        const capability = input.dataset.subjectQuery;
        input.addEventListener("input", () => this.schedule(capability));
        input.addEventListener("keydown", (event) => this.handleKey(event, capability));
      });
    }

    schedule(capability) {
      clearTimeout(this.timers.get(capability));
      this.timers.set(capability, setTimeout(() => void this.search(capability), 250));
    }

    handleKey(event, capability) {
      if (event.key !== "Enter") return;
      event.preventDefault();
      clearTimeout(this.timers.get(capability));
      void this.search(capability);
    }

    async search(capability) {
      const query = this.input(capability).value.trim();
      const guild = this.getGuild();
      if (!guild || !query) return this.clear(capability);
      const revision = this.nextRevision(capability);
      this.renderResults(capability, query, []);
      try {
        const members = await window.chatContext.searchDiscordGuildMembers(
          guild.guild_id, query,
        );
        if (!this.isCurrent(capability, revision, guild.guild_id)) return;
        this.renderResults(capability, query, members);
      } catch (error) {
        if (this.isCurrent(capability, revision, guild.guild_id)) {
          this.showToast(error.message, true);
        }
      }
    }

    renderResults(capability, query, members) {
      const normalized = query.toLocaleLowerCase();
      const roles = this.getRoles().filter((role) =>
        role.display_name.toLocaleLowerCase().includes(normalized));
      const candidates = this.availableCandidates(capability, roles, members);
      if (!candidates.length) return this.renderMessage(capability);
      this.results(capability).replaceChildren(
        ...candidates.map((subject) => this.resultButton(capability, subject)),
      );
    }

    availableCandidates(capability, roles, members) {
      const selected = this.getSubjects(capability);
      const isNew = (subject) => !selected.some((item) => sameSubject(item, subject));
      const roleCandidates = roles.map((role) => ({ ...role, subject_type: "role" }))
        .filter(isNew).slice(0, 12);
      const memberCandidates = members.map((member) => ({ ...member, subject_type: "user" }))
        .filter(isNew).slice(0, 13);
      return [...roleCandidates, ...memberCandidates];
    }

    resultButton(capability, subject) {
      const button = document.createElement("button");
      button.className = "quiet-button discord-subject-result";
      button.type = "button";
      const type = subject.subject_type === "role" ? "Role" : "Uživatel";
      button.textContent = `+ ${type} · ${subject.display_name}`;
      button.addEventListener("click", () => this.onAdd(capability, subject));
      return button;
    }

    renderMessage(capability) {
      const message = document.createElement("p");
      message.className = "discord-search-message";
      message.textContent = "Nenalezeny žádné výsledky.";
      this.results(capability).replaceChildren(message);
    }

    reset() {
      ["sync", "ask"].forEach((capability) => {
        const input = this.input(capability);
        if (input) input.value = "";
        this.clear(capability);
      });
    }

    clear(capability) {
      clearTimeout(this.timers.get(capability));
      this.nextRevision(capability);
      const input = this.input(capability);
      if (input) input.value = "";
      this.results(capability)?.replaceChildren();
    }

    isCurrent(capability, revision, guildId) {
      return this.revisions.get(capability) === revision
        && this.getGuild()?.guild_id === guildId;
    }

    nextRevision(capability) {
      const revision = (this.revisions.get(capability) || 0) + 1;
      this.revisions.set(capability, revision);
      return revision;
    }

    input(capability) { return document.getElementById(`discord-${capability}-subject-query`); }
    results(capability) { return document.getElementById(`discord-${capability}-subject-results`); }
  }

  function sameSubject(left, right) {
    return left.subject_type === right.subject_type && left.subject_id === right.subject_id;
  }

  return { create: (options) => new DiscordBotSubjectSearch(options) };
})();
