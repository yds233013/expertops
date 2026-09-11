-- Second database used exclusively by the integration + concurrency test suite.
-- Kept separate so `npm test` can truncate freely without touching dev data.
CREATE DATABASE expertops_test OWNER expertops;
