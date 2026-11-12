#!/usr/bin/env node
/*
 * Builds the CSV consumed by ESP-IDF's nvs_partition_gen.py to write the
 * device identity into the "mtdata" partition (namespace "mt").
 *   node tools/provision_device.js <device-id> <device-key-base64> > provision.csv
 * Then (see docs/PROVISIONING.md):
 *   python $IDF_PATH/components/nvs_flash/nvs_partition_generator/nvs_partition_gen.py \
 *       encrypt provision.csv mtdata.bin 0x100000 --inputkey keys/nvs_key.bin   (production)
 *   esptool.py --chip esp32s3 write_flash 0xC20000 mtdata.bin
 * The CSV contains a secret: create it in a temporary directory and delete it afterwards.
 */
'use strict';
const [id, key] = process.argv.slice(2);
if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || !key || Buffer.from(key, 'base64').length !== 32) {
  console.error('uso: node tools/provision_device.js <device-id> <chave-base64-de-32-bytes>');
  process.exit(1);
}
// stored as NVS blobs (the firmware reads blobs): base64 encoding -> raw bytes
process.stdout.write(['key,type,encoding,value', 'mt,namespace,,', `dev_id,data,base64,${Buffer.from(id).toString('base64')}`, `dev_key,data,base64,${key}`].join('\n') + '\n');
