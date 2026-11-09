#!/bin/bash
# Re-runnable GCP deploy for Spoor (single VM, reachable only through an IAP TCP tunnel).
# Usage: GCLOUD_ACCOUNT=you@example.com GCP_PROJECT=my-project deploy/deploy.sh   (from the project root)
#        TAG=v2 ... deploy/deploy.sh   (build + roll out a new image tag)
# Existing resources are reused, not recreated. Secret values are never printed.
set -euo pipefail
cd "$(dirname "$0")/.."

ACCOUNT=${GCLOUD_ACCOUNT:?set GCLOUD_ACCOUNT to the gcloud account that deploys}
PROJECT=${GCP_PROJECT:?set GCP_PROJECT to the Google Cloud project ID}
REGION=europe-west3
ZONE=europe-west3-a
G=(--account="$ACCOUNT" --project="$PROJECT" --quiet)
NET=saas-vpc; SUBNET=saas-subnet-ew3; ROUTER=saas-router; NAT=saas-nat
REPO=saas; SA_NAME=saas-vm; SA="$SA_NAME@$PROJECT.iam.gserviceaccount.com"
VM=saas-dashboard; SNAP=saas-daily-14d
TAG=${TAG:-$(date +%Y%m%d-%H%M%S)}
IMAGE="$REGION-docker.pkg.dev/$PROJECT/$REPO/saas-dashboard:$TAG"
exists() { "$@" "${G[@]}" >/dev/null 2>&1; }

echo "== APIs"
gcloud services enable compute.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com iap.googleapis.com "${G[@]}"

echo "== Network"
exists gcloud compute networks describe $NET || \
  gcloud compute networks create $NET --subnet-mode=custom "${G[@]}"
exists gcloud compute networks subnets describe $SUBNET --region=$REGION || \
  gcloud compute networks subnets create $SUBNET --network=$NET --region=$REGION \
    --range=10.10.0.0/24 --enable-private-ip-google-access "${G[@]}"
exists gcloud compute firewall-rules describe saas-allow-iap-ssh || \
  gcloud compute firewall-rules create saas-allow-iap-ssh --network=$NET --direction=INGRESS \
    --action=ALLOW --rules=tcp:22 --source-ranges=35.235.240.0/20 --priority=1000 "${G[@]}"
exists gcloud compute firewall-rules describe saas-allow-iap-app || \
  gcloud compute firewall-rules create saas-allow-iap-app --network=$NET --direction=INGRESS \
    --action=ALLOW --rules=tcp:8000 --source-ranges=35.235.240.0/20 --priority=1000 "${G[@]}"
exists gcloud compute firewall-rules describe saas-deny-all-ingress || \
  gcloud compute firewall-rules create saas-deny-all-ingress --network=$NET --direction=INGRESS \
    --action=DENY --rules=all --source-ranges=0.0.0.0/0 --priority=65000 "${G[@]}"
exists gcloud compute routers describe $ROUTER --region=$REGION || \
  gcloud compute routers create $ROUTER --network=$NET --region=$REGION "${G[@]}"
exists gcloud compute routers nats describe $NAT --router=$ROUTER --region=$REGION || \
  gcloud compute routers nats create $NAT --router=$ROUTER --region=$REGION \
    --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges "${G[@]}"

echo "== Artifact Registry + image $IMAGE"
exists gcloud artifacts repositories describe $REPO --location=$REGION || \
  gcloud artifacts repositories create $REPO --repository-format=docker --location=$REGION "${G[@]}"
gcloud builds submit --region=$REGION --tag="$IMAGE" . "${G[@]}"

echo "== Secrets (created once; later updates: gcloud secrets versions add ...)"
mk_secret() {  # name [data-file]
  exists gcloud secrets describe "$1" && return 0
  gcloud secrets create "$1" --replication-policy=user-managed --locations=$REGION ${2:+--data-file="$2"} "${G[@]}"
}
mk_secret saas-env .env
mk_secret saas-google-sa secrets/google-sa.json

echo "== VM service account + least-privilege IAM"
exists gcloud iam service-accounts describe "$SA" || \
  gcloud iam service-accounts create $SA_NAME --display-name="Spoor VM" "${G[@]}"
for s in saas-env saas-google-sa; do
  gcloud secrets add-iam-policy-binding $s --member="serviceAccount:$SA" \
    --role=roles/secretmanager.secretAccessor "${G[@]}" >/dev/null
done
gcloud artifacts repositories add-iam-policy-binding $REPO --location=$REGION \
  --member="serviceAccount:$SA" --role=roles/artifactregistry.reader "${G[@]}" >/dev/null
for r in roles/logging.logWriter roles/monitoring.metricWriter; do
  gcloud projects add-iam-policy-binding $PROJECT --member="serviceAccount:$SA" --role=$r \
    --condition=None "${G[@]}" >/dev/null
done

echo "== Snapshot schedule"
exists gcloud compute resource-policies describe $SNAP --region=$REGION || \
  gcloud compute resource-policies create snapshot-schedule $SNAP --region=$REGION \
    --daily-schedule --start-time=02:00 --max-retention-days=14 \
    --on-source-disk-delete=keep-auto-snapshots --storage-location=$REGION "${G[@]}"

echo "== VM"
if exists gcloud compute instances describe $VM --zone=$ZONE; then
  gcloud compute instances add-metadata $VM --zone=$ZONE --metadata=image="$IMAGE" \
    --metadata-from-file=startup-script=deploy/startup.sh "${G[@]}"
  gcloud compute ssh $VM --zone=$ZONE --tunnel-through-iap "${G[@]}" --command='sudo systemctl restart saas.service'
else
  gcloud compute instances create $VM --zone=$ZONE --machine-type=e2-small \
    --image-family=debian-12 --image-project=debian-cloud \
    --boot-disk-size=20GB --boot-disk-type=pd-balanced --boot-disk-device-name=$VM \
    --subnet=$SUBNET --no-address \
    --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
    --service-account="$SA" --scopes=cloud-platform \
    --metadata=enable-oslogin=TRUE,block-project-ssh-keys=TRUE,serial-port-enable=FALSE,image="$IMAGE" \
    --metadata-from-file=startup-script=deploy/startup.sh "${G[@]}"
  gcloud compute disks add-resource-policies $VM --zone=$ZONE --resource-policies=$SNAP "${G[@]}"
fi
echo "Deployed $IMAGE to $VM ($ZONE)"
