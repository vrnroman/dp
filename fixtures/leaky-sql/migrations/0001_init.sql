-- Regression fixture: a secret hidden in a migration file, which the platform RUNS on
-- deploy and ships. The scanner must read .sql, not just .ts/.js.
create table if not exists settings (k text primary key, v text);
insert into settings (k, v) values
  ('service_key', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.leaked-signature-abcdef123456'),
  ('db', 'postgresql://admin:hunter2pass@db.prod.example.com:5432/main');
