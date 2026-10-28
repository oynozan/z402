export type Log = (line: string) => void;

export const stderr: Log = (line) => {
  console.error(line);
};
