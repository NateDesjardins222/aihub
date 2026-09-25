-- M10-G: widen check-result status columns to fit NOT_CONFIGURED / NOT_VERIFIED.
ALTER TABLE "system_check_results" ALTER COLUMN "status" TYPE varchar(20);
ALTER TABLE "integrity_check_results" ALTER COLUMN "status" TYPE varchar(12);
