export const version = 4;

export const sql = `
CREATE TABLE metric_counts (
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  outcome TEXT NOT NULL,
  bucket TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL CHECK (count > 0),
  PRIMARY KEY (day, kind, name, outcome, bucket)
);
`;
