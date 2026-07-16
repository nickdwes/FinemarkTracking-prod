export const INSTALLATION_STATUS = {
  REQUESTED: "Requested",
  ASSIGNED: "Assigned",
  IN_PROGRESS: "InProgress",
  AWAITING_CONFIRMATION: "AwaitingConfirmation",
  COMPLETED: "Completed",
  RESCHEDULED: "Rescheduled",
  FAILED: "Failed",
} as const;

export type InstallationStatus = (typeof INSTALLATION_STATUS)[keyof typeof INSTALLATION_STATUS];

const TRANSITIONS: Record<InstallationStatus, InstallationStatus[]> = {
  [INSTALLATION_STATUS.REQUESTED]: [INSTALLATION_STATUS.ASSIGNED],
  [INSTALLATION_STATUS.ASSIGNED]: [INSTALLATION_STATUS.IN_PROGRESS],
  [INSTALLATION_STATUS.IN_PROGRESS]: [INSTALLATION_STATUS.AWAITING_CONFIRMATION],
  [INSTALLATION_STATUS.AWAITING_CONFIRMATION]: [
    INSTALLATION_STATUS.COMPLETED,
    INSTALLATION_STATUS.RESCHEDULED,
    INSTALLATION_STATUS.FAILED,
  ],
  [INSTALLATION_STATUS.RESCHEDULED]: [INSTALLATION_STATUS.ASSIGNED],
  [INSTALLATION_STATUS.COMPLETED]: [],
  [INSTALLATION_STATUS.FAILED]: [],
};

export const canTransition = (from: InstallationStatus, to: InstallationStatus) => {
  return (TRANSITIONS[from] || []).includes(to);
};

export const assertTransition = (from: InstallationStatus, to: InstallationStatus) => {
  if (!canTransition(from, to)) {
    const error = new Error(`Invalid transition from ${from} to ${to}`) as any;
    error.status = 400;
    error.code = "VALIDATION_ERROR";
    throw error;
  }
};
