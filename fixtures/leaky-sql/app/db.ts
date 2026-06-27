// Reads the connection from the environment (correct), so only the .sql/.toml leaks
// should be flagged. This isolates the file-type coverage of the scanner.
export const url = process.env.DATABASE_URL;
