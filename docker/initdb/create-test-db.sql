-- Runs once, on the first start of an empty volume. Integration tests use this database,
-- never the dev one.
CREATE DATABASE planted_test OWNER planted;
