// Explicit adapters from API values to visible labels and badge tones. Every dimension is separate:
// a request's decision, execution, observed access, verification and freshness are never merged.

export type Tone = "success" | "attention" | "failure" | "info" | "neutral";
export type StateMap = Record<string, readonly [label: string, tone: Tone]>;

export const DECISION: StateMap = {
  pending: ["Pending approval", "attention"],
  approved: ["Approved", "info"],
  rejected: ["Rejected", "neutral"],
  cancelled: ["Cancelled", "neutral"],
};

export const EXECUTION: StateMap = {
  not_started: ["Not started", "neutral"],
  completed: ["Completed", "info"],
  failed: ["Failed", "failure"],
};

export const OBSERVED: StateMap = {
  present: ["Present", "neutral"],
  absent: ["Absent", "neutral"],
  unknown: ["Unknown", "neutral"],
};

export const VERIFICATION: StateMap = {
  matched: ["Matched requested state", "success"],
  mismatch: ["Mismatch", "failure"],
  awaiting: ["Awaiting verification", "attention"],
  unavailable: ["Verification unavailable", "neutral"],
  not_applicable: ["Not applicable", "neutral"],
};

export const FRESHNESS: StateMap = {
  current: ["Current", "neutral"],
  stale: ["Stale", "attention"],
  unknown: ["Unknown freshness", "neutral"],
};

export const CONNECTION: StateMap = {
  connected: ["Connected", "info"],
  not_configured: ["Not configured", "neutral"],
  reauth_required: ["Reauthentication required", "failure"],
};

export const SYNC: StateMap = {
  not_synced: ["Not yet synced", "neutral"],
  syncing: ["Syncing", "info"],
  successful: ["Successful", "info"],
  partial: ["Partially completed", "attention"],
  failed: ["Failed", "failure"],
};

export const APP_STATUS: StateMap = {
  discovered: ["Discovered, needs decision", "attention"],
  sanctioned: ["Sanctioned", "info"],
  tolerated: ["Tolerated", "neutral"],
  unsanctioned: ["Unsanctioned", "neutral"],
  ignored: ["Ignored", "neutral"],
};

export const PERSON_STATUS: StateMap = {
  active: ["Active", "neutral"],
  suspended: ["Suspended", "attention"],
  deleted: ["Deleted", "neutral"],
};

export const ACCOUNT_STATE: StateMap = {
  active: ["Active", "neutral"],
  disabled: ["Disabled", "neutral"],
  removed: ["Removed", "neutral"],
};

export const SEVERITY: StateMap = {
  high: ["High", "failure"],
  medium: ["Medium", "attention"],
  low: ["Low", "neutral"],
  info: ["Info", "info"],
};

export const ISSUE_STATUS: StateMap = {
  open: ["Open", "attention"],
  accepted: ["Accepted risk", "neutral"],
  resolved: ["Resolved", "neutral"],
};

export const AUDIT_OUTCOME: StateMap = {
  completed: ["Completed", "info"],
  failed: ["Failed", "failure"],
};

export const REQUEST_TYPE: Record<string, string> = { grant: "Grant access", revoke: "Revoke access" };

export const SOURCE_LABEL: Record<string, string> = {
  google: "Google Workspace",
  entra: "Microsoft Entra ID",
  personio: "Personio (HR)",
  csv: "CSV import",
  manual: "Manual",
  builtin: "Built-in",
  google_oauth: "Google OAuth grant",
  google_saml: "Google SAML app",
  entra_sp: "Entra enterprise app",
  google_license: "Google licence",
  entra_sku: "Microsoft licence SKU",
};

export const EVIDENCE_LABEL: Record<string, string> = {
  directory: "Directory account",
  license: "Licence assignment",
  oauth_grant: "OAuth grant",
  sso_assignment: "SSO assignment",
  sso_login: "SSO sign-in",
  sign_in: "Sign-in",
  imported: "Imported account",
};

// Usage of an application by a person, from activity evidence; access alone never counts as use.
export const USAGE: StateMap = {
  active: ["Active", "info"],
  inactive: ["Inactive", "attention"],
  unknown: ["Usage unknown", "neutral"],
  insufficient_history: ["Not enough history", "neutral"],
};

export const ISSUE_KIND: Record<string, string> = {
  dormant_grant: "Unused grant to sensitive data",
  unused_app: "Nobody uses this app",
  leaver_access: "Leaver still has access",
  orphan_account: "Account matches no person",
  risky_scopes: "Sensitive data access",
  unreviewed_app: "New app needs a decision",
  no_owner: "Sanctioned app without owner",
  over_allocated: "Seats over-allocated",
  inactive_seats: "Inactive seats",
  renewal_due: "Renewal due",
  stale_connector: "Connector not syncing",
  hr_leaver: "Left per HR, account still active",
  hr_leaving_soon: "Leaving soon",
  hr_unmatched: "HR employee without account",
  no_hr_record: "Account without HR record",
};

// Employment status as Personio reports it; kept apart from the directory account status (PERSON_STATUS).
export const HR_STATUS: StateMap = {
  active: ["Employed", "neutral"],
  onboarding: ["Onboarding", "info"],
  leave: ["On leave", "neutral"],
  inactive: ["Left", "attention"],
};

export function stateOf(map: StateMap, value: string | null | undefined): readonly [string, Tone] {
  if (value && map[value]) return map[value];
  return [value ? `Unknown state (${value})` : "Unknown", "neutral"];
}

export const OFFBOARD_STEP: StateMap = {
  done: ["Done", "success"],
  failed: ["Failed", "failure"],
  not_run: ["Not run", "neutral"],
};

export const OFFBOARD_EVENT: Record<string, string> = {
  "offboarding.started": "Offboarding started",
  "offboarding.step_done": "Step done",
  "offboarding.step_failed": "Step failed",
  "offboarding.failed": "Offboarding could not start",
};
