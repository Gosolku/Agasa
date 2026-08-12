// Declared capabilities for the assistant.
//
// Two surfaces, at very different stages:
//
//   ui / memory — LIVE. The tool layer in src/tools/ dispatches these, and it
//                 consults decide() before every single call. These are cheap
//                 and reversible, which is why most of them are "allow": a
//                 confirmation dialogue in front of a theme switch is not
//                 security, it is friction that trains the user to click yes.
//
//   device      — STILL INERT. No code path in this Worker can install an app,
//                 change a system setting or run a command. These entries
//                 describe what such a layer would be permitted to attempt if
//                 it existed. It does not.
//
// The contract, for both: nothing executes unless its capability is listed
// here AND decide() returns "allow", AND — for anything resolving to "ask" —
// the user has confirmed that specific call.

export const PERMISSIONS = {
  version: 2,

  // What happens to a capability that isn't listed below. Deny, always.
  // An unknown tool call is a bug or an injection, never a feature.
  fallback: "deny",

  // "allow"  — may run without asking
  // "ask"    — may run only after explicit per-call confirmation
  // "deny"   — refused outright
  capabilities: [
    /* ── interface ─────────────────────────────────────────────── */
    {
      id: "ui.theme",
      surface: "ui",
      label: "Switch theme",
      detail: "Change the interface between dark and light.",
      decision: "allow",
      risk: "none",
      reversible: true,
    },
    {
      id: "ui.notify",
      surface: "ui",
      label: "Show a toast",
      detail: "Display a brief message at the bottom of the screen.",
      decision: "allow",
      risk: "none",
      reversible: true,
    },
    {
      id: "ui.console",
      surface: "ui",
      label: "Write to the thread",
      detail: "Add a console block to the conversation view.",
      decision: "allow",
      risk: "none",
      reversible: true,
    },
    {
      id: "ui.dialog",
      surface: "ui",
      label: "Open a dialog",
      detail: "Show a modal question and read which button was pressed.",
      decision: "allow",
      risk: "low",
      reversible: true,
    },
    {
      id: "ui.stage",
      surface: "ui",
      label: "Mount modules in the view stage",
      detail:
        "Open and close working surfaces beside or over the conversation.",
      decision: "allow",
      risk: "low",
      reversible: true,
    },
    {
      id: "ui.session",
      surface: "ui",
      label: "Manage sessions",
      // Clearing a session destroys history that lives nowhere else, so this
      // one is not in the same class as the rest of the UI surface.
      detail: "Create, switch between and empty conversation sessions.",
      decision: "ask",
      risk: "medium",
      reversible: false,
    },

    /* ── memory ────────────────────────────────────────────────── */
    {
      id: "memory.facts",
      surface: "memory",
      label: "Remember and forget facts",
      detail:
        "Record durable notes about you and your work, and delete them again. " +
        "Anything stored is injected into every later conversation.",
      decision: "allow",
      risk: "low",
      reversible: true,
    },
    {
      id: "memory.summaries",
      surface: "memory",
      label: "Summarise past sessions",
      detail:
        "Condense a finished conversation into a few lines kept for 90 days, " +
        "so old sessions stay available without their full transcripts.",
      decision: "allow",
      risk: "low",
      reversible: true,
    },

    /* ── device (inert) ────────────────────────────────────────── */
    {
      surface: "device",
      id: "system.read",
      label: "Read system information",
      detail: "OS version, installed applications, disk and battery state.",
      decision: "ask",
      risk: "low",
      reversible: true,
    },
    {
      surface: "device",
      id: "apps.install",
      label: "Install applications",
      detail: "Fetch and install software from a package manager.",
      decision: "ask",
      risk: "high",
      reversible: true,
    },
    {
      surface: "device",
      id: "apps.remove",
      label: "Remove applications",
      detail: "Uninstall software already on the machine.",
      decision: "ask",
      risk: "high",
      reversible: false,
    },
    {
      surface: "device",
      id: "settings.write",
      label: "Change system settings",
      detail: "Display, power, network and accessibility preferences.",
      decision: "ask",
      risk: "medium",
      reversible: true,
    },
    {
      surface: "device",
      id: "files.read",
      label: "Read files",
      detail: "Open files in directories explicitly named in the request.",
      decision: "ask",
      risk: "medium",
      reversible: true,
    },
    {
      surface: "device",
      id: "files.write",
      label: "Write or delete files",
      detail: "Create, modify or remove files on disk.",
      decision: "deny",
      risk: "high",
      reversible: false,
    },
    {
      surface: "device",
      id: "shell.exec",
      label: "Run arbitrary shell commands",
      detail: "Execute a command of the model's choosing.",
      decision: "deny",
      risk: "critical",
      reversible: false,
    },
  ],
};

/**
 * Resolve a capability id to a decision. Every dispatch in the tool layer goes
 * through here first, including the ones that will obviously be allowed —
 * there is deliberately no fast path, because a fast path is how a capability
 * ends up running without ever being checked.
 *
 * @returns {"allow"|"ask"|"deny"}
 */
export function decide(capabilityId) {
  const found = PERMISSIONS.capabilities.find((c) => c.id === capabilityId);
  if (!found) return PERMISSIONS.fallback;
  // A device capability cannot be allowed by configuration alone, whatever the
  // list says, because there is nothing on the other side of it to run. If an
  // executor ever lands, this line is what it has to delete on purpose.
  if (found.surface === "device") return "deny";
  return found.decision;
}

/** The shape the front end gets — the declaration plus which surfaces of it
 *  are actually connected to anything. */
export function publicPermissions() {
  return {
    version: PERMISSIONS.version,
    fallback: PERMISSIONS.fallback,
    active: ["ui", "memory"],
    inert: ["device"],
    capabilities: PERMISSIONS.capabilities,
  };
}
