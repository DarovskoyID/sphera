"""Bounded, additive point-state migration. No arbitrary SQL or data rollback."""
import hashlib
from pathlib import Path
import re
import sqlite3
from release_v1 import canonical

DATABASES={'auth.sqlite','replays.sqlite','blobs.sqlite','directory.sqlite','health.sqlite','replica.sqlite','replica-replays.sqlite','controller-manifestq.sqlite'}


def known_database(name):
    return isinstance(name,str) and (name in DATABASES or name in {'controller-initial.sqlite','controller-capacity.sqlite','controller-failure.sqlite'} or re.fullmatch(r'controller-m-[0-9a-f]{64}\.sqlite',name) is not None)


def digest(value):return hashlib.sha256(canonical(value)).hexdigest()


def schema(db):
    return [list(row) for row in db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name")]


def snapshot(state):
    state=Path(state);result={}
    for path in sorted(state.glob('*.sqlite')):
        if not known_database(path.name) or path.is_symlink() or not path.is_file():raise ValueError('unknown_or_linked_state_database')
        db=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True)
        try:result[path.name]=schema(db)
        finally:db.close()
    if not {'auth.sqlite','replays.sqlite','blobs.sqlite','directory.sqlite'}<=set(result):raise ValueError('core_database_schema_missing')
    return result


def identifier(value):
    if not isinstance(value,str) or not re.fullmatch('[a-z][a-z0-9_]{0,62}',value) or value.startswith('sqlite_'):raise ValueError('migration_identifier')
    return '"'+value+'"'


def statement(operation):
    if not isinstance(operation,dict) or set(operation)!={'database','table','columns'} or not known_database(operation['database']):raise ValueError('additive_migration_schema')
    table=identifier(operation['table']);columns=operation['columns']
    if not isinstance(columns,list) or not 1<=len(columns)<=32:raise ValueError('migration_column_limit')
    names=set();definitions=[]
    for column in columns:
        if not isinstance(column,dict) or set(column)!={'name','type'} or column['type'] not in ('TEXT','INTEGER','BLOB','REAL'):raise ValueError('migration_column_schema')
        name=identifier(column['name'])
        if name in names:raise ValueError('migration_duplicate_column')
        names.add(name);definitions.append(name+' '+column['type'])
    return 'CREATE TABLE '+table+' ('+', '.join(definitions)+')'


def projected(before,operations):
    if not isinstance(operations,list) or len(operations)>8:raise ValueError('migration_operation_limit')
    databases={operation.get('database') for operation in operations if isinstance(operation,dict)}
    if len(databases)>1:raise ValueError('single_database_atomic_migration_required')
    after={name:[list(row) for row in rows] for name,rows in before.items()}
    for operation in operations:
        sql=statement(operation);name=operation['database']
        if name not in after or any(row[1]==operation['table'] for row in after[name]):raise ValueError('migration_requires_new_table_in_existing_database')
        after[name].append(['table',operation['table'],operation['table'],sql]);after[name].sort(key=lambda row:(row[0],row[1]))
    return after


def migrate(state,before,operations):
    """Caller holds lifetime state lock and has stopped its owned process."""
    after=projected(before,operations)
    if snapshot(state)!=before:raise ValueError('state_schema_changed_before_migration')
    if not operations:return after
    path=Path(state)/operations[0]['database'];db=sqlite3.connect(path.as_uri()+'?mode=rw',uri=True)
    try:
        db.execute('PRAGMA synchronous=FULL');db.execute('BEGIN IMMEDIATE')
        if schema(db)!=before[path.name]:raise ValueError('migration_schema_race')
        for operation in operations:db.execute(statement(operation))
        if schema(db)!=after[path.name]:raise ValueError('migration_result_schema_mismatch')
        db.commit()
    except BaseException:
        db.rollback();raise
    finally:db.close()
    return after
