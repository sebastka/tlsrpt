-- Runs once when the dev MariaDB volume is created.
-- The app user also owns the demo and test databases.
CREATE DATABASE IF NOT EXISTS tlsrpt_demo CHARACTER SET utf8mb4;
CREATE DATABASE IF NOT EXISTS tlsrpt_test CHARACTER SET utf8mb4;
GRANT ALL PRIVILEGES ON `tlsrpt\_demo`.* TO 'tlsrpt'@'%';
-- tlsrpt_test and tlsrpt_test_* (the cleanup test uses its own database).
GRANT ALL PRIVILEGES ON `tlsrpt\_test%`.* TO 'tlsrpt'@'%';
