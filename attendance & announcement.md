i ahve some attendance related table's schema":
1. 
create table student.attendance_records (
  id bigserial not null,
  student_id text null,
  date date not null,
  entry_time time without time zone null,
  exit_time time without time zone null,
  entry_device_id text null,
  exit_device_id text null,
  nfc_uid text null,
  pass jsonb null,
  last_pass_event_type text null,
  last_pass_event_time time without time zone null,
  constraint attendance_records_pkey primary key (id),
  constraint attendance_records_nfc_uid_date_key unique (nfc_uid, date)
) TABLESPACE pg_default;

create index IF not exists att_student on student.attendance_records using btree (student_id) TABLESPACE pg_default;

create index IF not exists att_nfc_date on student.attendance_records using btree (nfc_uid, date) TABLESPACE pg_default;

create trigger trg_att_fill BEFORE INSERT
or
update on student.attendance_records for EACH row
execute FUNCTION student.att_fill_student ();

create trigger trg_att_pass BEFORE INSERT
or
update on student.attendance_records for EACH row
execute FUNCTION student.att_fill_pass ();
2.
create table student.device_config (
  id bigserial not null,
  created_at timestamp with time zone null default now(),
  version text null default ''::text,
  url text null,
  software_name text null,
  md5 text null,
  constraint device_config_pkey primary key (id)
) TABLESPACE pg_default;
3.
create table student.device_health (
  id bigserial not null,
  created_at timestamp with time zone null default now(),
  device_name text null,
  status text null,
  device_hash text null,
  device_name_by_system text null,
  wifi_ssid text null,
  wifi_ssid_pass text null,
  firmware_version text null,
  firmware_url text null,
  assigned_class text null,
  assigned_section text null,
  constraint device_health_pkey primary key (id),
  constraint device_health_device_hash_key unique (device_hash)
) TABLESPACE pg_default;

create unique INDEX IF not exists device_health_device_hash_uniq on student.device_health using btree (device_hash) TABLESPACE pg_default
where
  (device_hash is not null);
4.
create table student.p10_display_devices (
  id bigserial not null,
  created_at timestamp with time zone null default now(),
  device_name text null,
  status text null,
  device_hash text null,
  paired_device_name text null,
  wifi_ssid text null,
  wifi_ssid_pass text null,
  firmware_version text null,
  firmware_url text null,
  assigned_class text null,
  assigned_section text null,
  constraint p10_display_devices_pkey primary key (id),
  constraint p10_display_devices_device_hash_key unique (device_hash)
) TABLESPACE pg_default;
5. 
create table public.announcements (
  id bigint generated always as identity not null,
  title text not null,
  file_url text not null,
  target_devices text[] not null default '{}'::text[],
  active boolean not null default true,
  created_by text null,
  created_at timestamp with time zone not null default now(),
  play_at timestamp with time zone null,
  played_by jsonb not null default '[]'::jsonb,
  constraint announcements_pkey primary key (id)
) TABLESPACE pg_default;

create index IF not exists idx_announcements_active on public.announcements using btree (active, id desc) TABLESPACE pg_default;

i'm using two esp32 device to take attendance 1.nfc scanner(primary device), 2. p10 display+annoncement device. code is given below
1. E:\important\vs code\ID Card\esp32 attendance\Class_in_out\src\main.cpp
2. E:\important\vs code\ID Card\esp32 attendance\p10_display\src\main.cpp
 
