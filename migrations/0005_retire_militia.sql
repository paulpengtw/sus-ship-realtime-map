-- migrations/0005_retire_militia.sql — remove the never-raised militia_presence category.
DELETE FROM assessments WHERE category = 'militia_presence';
