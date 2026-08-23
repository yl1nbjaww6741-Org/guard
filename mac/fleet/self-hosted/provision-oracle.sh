#!/usr/bin/env bash
# Retry loop for the Always Free Ampere A1 shape (VM.Standard.A1.Flex).
# This is the genuinely annoying part of the Oracle path: the free ARM
# capacity is real, but Oracle's API returns "Out of host capacity" on
# most launch attempts during busy periods - this just keeps trying
# until one succeeds. Once an instance exists, it isn't reclaimed for
# capacity reasons - this loop is a one-time hurdle, not an ongoing cost.
#
# Can't be run from this sandboxed environment (no Oracle account access
# here, same limitation as every other phase of this project - see
# ../../README.md's "Why Phase 0 has no code"). Run this yourself, from
# wherever you have the OCI CLI set up.
#
# Prerequisites:
#   1. An Oracle Cloud "Always Free" account (oracle.com/cloud/free) -
#      needs a real, verifiable credit card at signup even though you
#      won't be charged, per Oracle's identity-verification requirement.
#   2. OCI CLI installed and configured: `oci setup config` (walks you
#      through generating an API key and writing ~/.oci/config).
#   3. Pick your home region at signup based on where capacity actually
#      exists, not just where Command's users are - Ampere A1 Always Free
#      capacity is scarcest in the most popular regions. If this loop
#      hasn't succeeded within a day or two of steady retrying, that's
#      your signal to stop and use provision-hetzner.md instead - see
#      CUTOVER.md, this whole setup is built so that's a cheap decision.
#
# Fill in the four placeholders below from your own tenancy (OCI Console
# > each resource's page has its OCID in the details panel):
COMPARTMENT_ID="ocid1.tenancy.oc1..REPLACE_ME"
SUBNET_ID="ocid1.subnet.oc1..REPLACE_ME"
AVAILABILITY_DOMAIN="REPLACE_ME"   # e.g. `oci iam availability-domain list`
SSH_PUBLIC_KEY_FILE="$HOME/.ssh/id_ed25519.pub"

set -uo pipefail   # deliberately not -e - a failed launch attempt here
                    # is the expected, common case, not a script bug

IMAGE_ID="$(oci compute image list \
  --compartment-id "$COMPARTMENT_ID" \
  --operating-system "Canonical Ubuntu" \
  --operating-system-version "22.04" \
  --shape "VM.Standard.A1.Flex" \
  --sort-by TIMECREATED --sort-order DESC \
  --query 'data[0].id' --raw-output)"

echo "Using image: $IMAGE_ID"
echo "Retrying VM.Standard.A1.Flex launch (2 OCPU / 12GB, the current"
echo "Always Free ceiling as of the June 2026 allotment cut) until it"
echo "succeeds. Ctrl-C to stop; safe to re-run this script later."

ATTEMPT=0
while true; do
  ATTEMPT=$((ATTEMPT + 1))
  echo "[$(date -Is)] attempt #$ATTEMPT..."

  RESULT="$(oci compute instance launch \
    --compartment-id "$COMPARTMENT_ID" \
    --availability-domain "$AVAILABILITY_DOMAIN" \
    --shape "VM.Standard.A1.Flex" \
    --shape-config '{"ocpus": 2, "memoryInGBs": 12}' \
    --image-id "$IMAGE_ID" \
    --subnet-id "$SUBNET_ID" \
    --assign-public-ip true \
    --ssh-authorized-keys-file "$SSH_PUBLIC_KEY_FILE" \
    --display-name "contentguard-oracle" \
    2>&1)"

  if echo "$RESULT" | grep -q '"lifecycle-state": "PROVISIONING"'; then
    echo "$RESULT"
    echo "[$(date -Is)] launched successfully after $ATTEMPT attempt(s)."
    break
  fi

  if echo "$RESULT" | grep -qi 'Out of host capacity'; then
    echo "  out of capacity, waiting 60s before retrying..."
    sleep 60
  else
    echo "  unexpected error - not a capacity issue, stopping to avoid"
    echo "  retrying into something that will never succeed:"
    echo "$RESULT"
    exit 1
  fi
done

cat <<'EOF'

Next steps once this instance is running (OCI Console > Compute >
Instances > contentguard-oracle for its public IP):
  1. Open ingress for the SSH port only in the instance's security list/
     NSG (everything else stays closed - cloudflared is outbound-only,
     nothing else needs an inbound rule).
  2. ssh in, install Docker + the Compose plugin.
  3. git clone this repo, cd mac/fleet/self-hosted, fill in .env.
  4. docker compose up -d
  5. Set up backup.sh on a cron/systemd timer immediately - see
     ../README.md's "Order of operations".
EOF
