"""One contract for implemented operations and their storage scope."""
def capabilities():
    from django.conf import settings
    return {'mode':'distributed','contract_version':1,'legacy_account_bootstrap':True,
        'module_catalog':True,'module_management':False,'status_scope':'entry',
        'contacts_scope':'entry','settings_scope':'entry','profile_details_scope':'entry',
        'account_identity_scope':'network','dialog_identity_scope':'network','websocket':'same-origin',
        'device_signed_dialogs':True,'device_signed_signaling':True,
        'distributed_key_transport':True,'distributed_message_transport':True,
        'turn_media_relay':bool(getattr(settings,'SFERA_TURN_SECRET','')),'network_account_withdrawal':False}
