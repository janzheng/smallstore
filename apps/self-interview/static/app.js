// Self-Interview App — Alpine.js frontend
// Connects to the Hono API at /api/*

function interviewApp() {
  return {
    // State
    session: null,
    missions: [],
    sessions: [],
    messages: [],
    notes: [],
    status: null,
    userInput: "",
    selectedMission: null,
    customMissionText: "",
    newSessionName: "",
    initializing: true,
    loading: false,
    starting: false,
    sidebarOpen: false,
    settingsOpen: false,
    aiConfig: { apiKey: "", baseUrl: "", model: "" },

    get isCustomMission() {
      return this.selectedMission === "__custom__";
    },

    get canStart() {
      if (!this.newSessionName) return false;
      if (this.isCustomMission) return this.customMissionText.trim().length >= 10;
      return !!this.selectedMission;
    },

    async init() {
      this.loadSettings();
      try {
        await Promise.all([this.loadMissions(), this.loadSessions()]);
      } finally {
        this.initializing = false;
      }
    },

    // ---- Settings ----

    loadSettings() {
      try {
        const saved = localStorage.getItem("interview-ai-config");
        if (saved) this.aiConfig = { ...this.aiConfig, ...JSON.parse(saved) };
      } catch {}
    },

    saveSettings() {
      localStorage.setItem("interview-ai-config", JSON.stringify(this.aiConfig));
    },

    clearSettings() {
      this.aiConfig = { apiKey: "", baseUrl: "", model: "" };
      localStorage.removeItem("interview-ai-config");
    },

    aiPayload() {
      const { apiKey, baseUrl, model } = this.aiConfig;
      if (apiKey || baseUrl || model) return { ai: { apiKey, baseUrl, model } };
      return {};
    },

    // ---- API helpers ----

    async api(path, opts = {}) {
      const res = await fetch(`/api${path}`, {
        headers: { "Content-Type": "application/json" },
        ...opts,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `API error ${res.status}`);
      }
      return res.json();
    },

    // ---- Data loading ----

    async loadMissions() {
      try {
        const data = await this.api("/missions");
        this.missions = data.missions || [];
        if (this.missions.length && !this.selectedMission) {
          this.selectedMission = this.missions[0].slug;
        }
      } catch (e) {
        console.error("Failed to load missions:", e);
      }
    },

    async loadSessions() {
      try {
        const data = await this.api("/sessions");
        this.sessions = data.sessions || [];
      } catch (e) {
        console.error("Failed to load sessions:", e);
      }
    },

    async loadNotes() {
      if (!this.session) return;
      try {
        const data = await this.api(`/sessions/${encodeURIComponent(this.session)}/notes`);
        this.notes = data.notes || [];
      } catch (e) {
        console.error("Failed to load notes:", e);
      }
    },

    async loadStatus() {
      if (!this.session) return;
      try {
        this.status = await this.api(`/sessions/${encodeURIComponent(this.session)}/status`);
      } catch (e) {
        console.error("Failed to load status:", e);
      }
    },

    // ---- Session management ----

    async startSession() {
      if (!this.canStart) return;
      this.starting = true;
      try {
        const payload = this.isCustomMission
          ? { customMission: this.customMissionText.trim(), ...this.aiPayload() }
          : { mission: this.selectedMission, ...this.aiPayload() };

        const data = await this.api(`/sessions/${encodeURIComponent(this.newSessionName)}/start`, {
          method: "POST",
          body: JSON.stringify(payload),
        });

        this.session = this.newSessionName;
        this.messages = [];
        this.status = data.status;

        // Add greeting as first message
        if (data.greeting) {
          this.messages.push({ role: "assistant", content: data.greeting });
        }

        this.newSessionName = "";
        this.customMissionText = "";
        this.sidebarOpen = false;
        await this.loadNotes();
        this.scrollToBottom();
        this.$nextTick(() => this.$refs.input?.focus());
      } catch (e) {
        alert(`Failed to start session: ${e.message}`);
      } finally {
        this.starting = false;
      }
    },

    async resumeSession(name) {
      this.starting = true;
      try {
        // Phase 1: instant — load history from cache (no AI call)
        const data = await this.api(`/sessions/${encodeURIComponent(name)}/start`, {
          method: "POST",
          body: JSON.stringify({ ...this.aiPayload() }),
        });

        this.session = name;
        this.status = data.status;
        this.messages = (data.history || []).map((m) => ({
          role: m.role,
          content: m.content,
        }));

        this.sidebarOpen = false;
        await this.loadNotes();
        this.scrollToBottom();
        this.starting = false;

        // Phase 2: background — fetch AI greeting with typing indicator
        this.loading = true;
        this.scrollToBottom();
        try {
          const greetData = await this.api(`/sessions/${encodeURIComponent(name)}/greet`, {
            method: "POST",
            body: JSON.stringify({ ...this.aiPayload() }),
          });
          if (greetData.greeting) {
            this.messages.push({ role: "assistant", content: greetData.greeting });
          }
        } catch (e) {
          console.warn("Greeting failed (non-critical):", e.message);
        } finally {
          this.loading = false;
          this.scrollToBottom();
          this.$nextTick(() => this.$refs.input?.focus());
        }
      } catch (e) {
        alert(`Failed to resume session: ${e.message}`);
        this.starting = false;
      }
    },

    async deleteSession(name) {
      if (!confirm(`Delete session "${name}"?`)) return;
      try {
        await this.api(`/sessions/${encodeURIComponent(name)}`, { method: "DELETE" });
        this.sessions = this.sessions.filter((s) => s.name !== name);
        if (this.session === name) this.endSession();
      } catch (e) {
        alert(`Failed to delete: ${e.message}`);
      }
    },

    endSession() {
      this.session = null;
      this.messages = [];
      this.notes = [];
      this.status = null;
      this.loadSessions();
    },

    // ---- Chat ----

    async sendMessage() {
      const text = this.userInput.trim();
      if (!text || this.loading) return;

      this.messages.push({ role: "user", content: text });
      this.userInput = "";
      this.loading = true;
      this.scrollToBottom();

      // Reset textarea height
      if (this.$refs.input) this.$refs.input.style.height = "auto";

      try {
        const data = await this.api(`/sessions/${encodeURIComponent(this.session)}/turn`, {
          method: "POST",
          body: JSON.stringify({ message: text, ...this.aiPayload() }),
        });

        this.messages.push({ role: "assistant", content: data.response });

        // Update status inline
        this.status = {
          ...this.status,
          noteCount: data.noteCount,
          stats: {
            ...this.status?.stats,
            totalMessages: data.messageCount,
            activeTokens: data.activeTokens,
          },
        };

        await this.loadNotes();
      } catch (e) {
        this.messages.push({ role: "assistant", content: `Error: ${e.message}` });
      } finally {
        this.loading = false;
        this.scrollToBottom();
        this.$nextTick(() => this.$refs.input?.focus());
      }
    },

    // ---- Utilities ----

    scrollToBottom() {
      this.$nextTick(() => {
        const el = this.$refs.messages;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },

    autoResize(e) {
      const el = e.target;
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 200) + "px";
    },

    renderMarkdown(text) {
      if (!text) return "";
      // Simple markdown: bold, italic, code, paragraphs
      return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*(.+?)\*/g, "<em>$1</em>")
        .replace(/`(.+?)`/g, "<code>$1</code>")
        .replace(/\n\n/g, "</p><p>")
        .replace(/\n/g, "<br>")
        .replace(/^/, "<p>")
        .replace(/$/, "</p>");
    },
  };
}
