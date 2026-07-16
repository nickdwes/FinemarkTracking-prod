import bcrypt from "bcrypt";

export const hashPassword = async (plain: string) => {
  const saltRounds = 10;
  return bcrypt.hash(plain, saltRounds);
};

export const verifyPassword = async (plain: string, hash: string) => {
  return bcrypt.compare(plain, hash);
};
