-- Third database, used exclusively by the Playwright browser suite.
-- Kept separate from expertops_test so a browser run and a vitest run cannot
-- truncate each other's fixtures even when both are in flight.
CREATE DATABASE expertops_e2e OWNER expertops;
