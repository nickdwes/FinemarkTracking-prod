type PasswordPolicyResult = {
  ok: boolean;
  errors: string[];
};

export const validatePassword = (password: string): PasswordPolicyResult => {
  const errors: string[] = [];

  if (!password || password.length < 8) {
    errors.push("Password must be at least 8 characters.");
  }
  if (!/[A-Z]/.test(password || "")) {
    errors.push("Password must include an uppercase letter.");
  }
  if (!/[0-9]/.test(password || "")) {
    errors.push("Password must include a number.");
  }

  return { ok: errors.length === 0, errors };
};
