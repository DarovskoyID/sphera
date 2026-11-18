"""Trusted supervisor launcher: enforce the admitted SQLite schema on connections."""
import hashlib
from pathlib import Path
import runpy
import sqlite3
import sys
from urllib.parse import urlsplit,unquote
from release_v1 import parse
from server_schema import schema


def install(state,approved):
    state=Path(state).resolve();connect=sqlite3.connect
    creates={sqlite3.SQLITE_CREATE_INDEX,sqlite3.SQLITE_CREATE_TABLE,sqlite3.SQLITE_CREATE_TRIGGER,sqlite3.SQLITE_CREATE_VIEW}
    destructive={sqlite3.SQLITE_DROP_INDEX,sqlite3.SQLITE_DROP_TABLE,sqlite3.SQLITE_DROP_TRIGGER,sqlite3.SQLITE_DROP_VIEW,sqlite3.SQLITE_ALTER_TABLE,
        sqlite3.SQLITE_CREATE_TEMP_TABLE,sqlite3.SQLITE_CREATE_TEMP_INDEX,sqlite3.SQLITE_CREATE_TEMP_TRIGGER,sqlite3.SQLITE_CREATE_TEMP_VIEW,
        sqlite3.SQLITE_DROP_TEMP_TABLE,sqlite3.SQLITE_DROP_TEMP_INDEX,sqlite3.SQLITE_DROP_TEMP_TRIGGER,sqlite3.SQLITE_DROP_TEMP_VIEW,
        sqlite3.SQLITE_ATTACH,sqlite3.SQLITE_DETACH,sqlite3.SQLITE_CREATE_VTABLE,sqlite3.SQLITE_DROP_VTABLE}
    class Guarded(sqlite3.Connection):
        def set_authorizer(self,*args,**kwargs):raise ValueError('schema_authorizer_is_supervisor_owned')
        def enable_load_extension(self,*args,**kwargs):raise ValueError('sqlite_extensions_disabled')
        def load_extension(self,*args,**kwargs):raise ValueError('sqlite_extensions_disabled')
        def deserialize(self,*args,**kwargs):raise ValueError('schema_deserialize_disabled')
    def guarded(database,*args,**kwargs):
        if len(args)>4 or 'factory' in kwargs:raise ValueError('sqlite_connection_factory_disabled')
        raw=str(database)
        if raw==':memory:':path=None;rows=[]
        else:
            if kwargs.get('uri'):
                url=urlsplit(raw)
                if url.scheme!='file' or url.netloc:raise ValueError('local_sqlite_uri_required')
                path=Path(unquote(url.path))
            else:path=Path(raw)
            if not path.is_absolute() or path.is_symlink() or path.resolve().parent!=state or path.name not in approved:raise ValueError('unapproved_sqlite_database')
            rows=approved[path.name]
        db=connect(database,*args,factory=Guarded,**kwargs)
        try:
            if path is not None and schema(db)!=rows:raise ValueError('unapproved_sqlite_schema')
            names={row[1] for row in rows}
            def authorize(action,arg1,arg2,dbname,source):
                if action in destructive:return sqlite3.SQLITE_DENY
                if action in creates and arg1 not in names:return sqlite3.SQLITE_DENY
                if action==sqlite3.SQLITE_PRAGMA and arg2 is not None and str(arg1).lower() in ('writable_schema','schema_version','trusted_schema'):return sqlite3.SQLITE_DENY
                if action==sqlite3.SQLITE_FUNCTION and str(arg2).lower()=='load_extension':return sqlite3.SQLITE_DENY
                return sqlite3.SQLITE_OK
            sqlite3.Connection.set_authorizer(db,authorize)
            return db
        except BaseException:db.close();raise
    sqlite3.connect=guarded
    from sqlite3 import dbapi2
    dbapi2.connect=guarded


def main():
    policy,pin,entry=sys.argv[1:4];arguments=sys.argv[4:];raw=Path(policy).read_bytes()
    if hashlib.sha256(raw).hexdigest()!=pin:raise ValueError('supervisor_schema_policy_changed')
    value=parse(raw,1024*1024);install(value['state'],value['databases'])
    sys.argv=[entry,*arguments];sys.path.insert(0,str(Path(entry).parent));runpy.run_path(entry,run_name='__main__')


if __name__=='__main__':main()
