// contentguard-release entry point. A separate, short-lived command-line
// tool - NOT part of ContentGuardDaemon - invoked by hand (via the vaulted
// admin credentials, see mac/README.md's ratchet/vault design) to clear an
// active blackout or reset escalation state. See AdminRelease.swift's own
// doc comment for why this has to be a standalone executable rather than
// an RPC path inside the daemon: the AuthorizationServices prompt run by
// this process's own privilege, not anything the daemon has to verify
// about its caller, is the actual gate.
//
// Deliberately just this one line of dispatch - all real logic lives in
// AdminReleaseTool.run().

exit(AdminReleaseTool.run())
