import config from '../config';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { VMManager, VM } from './base';
import { cloudInit, imageName } from './utils';

const HETZNER_TOKEN = config.HETZNER_TOKEN;
const sshKeys = config.HETZNER_SSH_KEYS.split(',').map(Number);
const imageId = Number(config.HETZNER_IMAGE);

export class Hetzner extends VMManager {
  size = 'cpx11'; // cx11, cpx11, cpx21, cpx31, ccx11
  largeSize = 'cpx31';
  id = 'Hetzner';
  networks = (this.region === 'US'
    ? config.HETZNER_NETWORKS_US
    : config.HETZNER_NETWORKS
  )
    .split(',')
    .map(Number);
  gateway =
    this.region === 'US' ? config.HETZNER_GATEWAY_US : config.HETZNER_GATEWAY;
  datacenters = this.region === 'US' ? ['ash'] : ['nbg1', 'fsn1', 'hel1'];

  startVM = async (name: string) => {
    const response = await axios({
      method: 'POST',
      url: `https://api.hetzner.cloud/v1/servers`,
      headers: {
        Authorization: 'Bearer ' + HETZNER_TOKEN,
        'Content-Type': 'application/json',
      },
      data: {
        name: name,
        server_type: this.isLarge ? this.largeSize : this.size,
        start_after_create: true,
        image: imageId,
        ssh_keys: sshKeys,
        networks: [
          this.networks[Math.floor(Math.random() * this.networks.length)],
        ],
        user_data: cloudInit(
          imageName,
          this.isLarge ? '1920x1080@30' : undefined,
          false,
          false,
          true
        ),
        labels: {
          [this.getTag()]: '1',
          originalName: name,
        },
        location:
          this.datacenters[Math.floor(Math.random() * this.datacenters.length)],
      },
    });
    const id = response.data.server.id;
    return id;
  };

  terminateVM = async (id: string) => {
    await axios({
      method: 'DELETE',
      url: `https://api.hetzner.cloud/v1/servers/${id}`,
      headers: {
        Authorization: 'Bearer ' + HETZNER_TOKEN,
      },
    });
  };

  rebootVM = async (id: string) => {
    // Hetzner does not update the hostname automatically on instance name update + reboot
    // It requires a rebuild command
    // Generate a new password
    const password = uuidv4();

    // Update the VM's name
    await axios({
      method: 'PUT',
      url: `https://api.hetzner.cloud/v1/servers/${id}`,
      headers: {
        Authorization: 'Bearer ' + HETZNER_TOKEN,
        'Content-Type': 'application/json',
      },
      data: {
        name: password,
      },
    });

    // Rebuild the VM
    await axios({
      method: 'POST',
      url: `https://api.hetzner.cloud/v1/servers/${id}/actions/rebuild`,
      headers: {
        Authorization: 'Bearer ' + HETZNER_TOKEN,
      },
      data: {
        image: imageId,
      },
    });
    return;
  };

  getVM = async (id: string) => {
    const response: any = await axios({
      method: 'GET',
      url: `https://api.hetzner.cloud/v1/servers/${id}`,
      headers: {
        Authorization: 'Bearer ' + HETZNER_TOKEN,
      },
    });
    console.log(
      '[GETVM] %s rate limit remaining',
      response?.headers['ratelimit-remaining']
    );
    const server = this.mapServerObject(response.data.server);
    if (!server.private_ip) {
      return null;
    }
    return server;
  };

  listVMs = async (filter?: string) => {
    const limit = this.isLarge
      ? config.VM_POOL_LIMIT_LARGE
      : config.VM_POOL_LIMIT;
    const pageCount = Math.ceil((limit || 1) / 50);
    const pages = Array.from(Array(pageCount).keys()).map((i) => i + 1);
    const responses: any[] = await Promise.all(
      pages.map((page) =>
        axios({
          method: 'GET',
          url: `https://api.hetzner.cloud/v1/servers`,
          headers: {
            Authorization: 'Bearer ' + HETZNER_TOKEN,
          },
          params: {
            sort: 'id:asc',
            page,
            per_page: 50,
            label_selector: filter,
          },
        })
      )
    );
    const responsesMapped = responses.map((response) =>
      response.data.servers
        .map(this.mapServerObject)
        .filter((server: VM) => server.tags.includes(this.getTag()))
    );
    return responsesMapped.flat();
  };

  powerOn = async (id: string) => {
    // Poweron the server (usually not needed)
    try {
      await axios({
        method: 'POST',
        url: `https://api.hetzner.cloud/v1/servers/${id}/actions/poweron`,
        headers: {
          Authorization: 'Bearer ' + HETZNER_TOKEN,
          'Content-Type': 'application/json',
        },
      });
    } catch (e) {
      console.log('failed to poweron');
    }
  };

  attachToNetwork = async (id: string) => {
    // Attach server to network (usually not needed)
    try {
      await axios({
        method: 'POST',
        url: `https://api.hetzner.cloud/v1/servers/${id}/actions/attach_to_network`,
        headers: {
          Authorization: 'Bearer ' + HETZNER_TOKEN,
          'Content-Type': 'application/json',
        },
        data: {
          network: this.networks.slice(-1)[0],
        },
      });
    } catch (e) {
      console.log('failed to attach to network');
    }
  };

  mapServerObject = (server: any): VM => {
    //const ip = server.public_net?.ipv4?.ip;
    const ip = server.private_net?.[0]?.ip;
    return {
      id: server.id?.toString(),
      pass: server.name,
      // The gateway handles SSL termination and proxies to the private IP
      host: `${this.gateway}/?ip=${ip}`,
      private_ip: ip,
      state: server.status,
      tags: Object.keys(server.labels),
      creation_date: server.created,
      originalName: server.labels.originalName,
      provider: this.id,
      large: this.isLarge,
      region: this.region,
    };
  };
}
