import { defineConfig } from 'vocs/config';

export default defineConfig({
  title: 'Roboport',
  description: 'Agents as Code',
  sidebar: [
    { text: 'Overview', link: '/' },
    {
      text: 'Concepts',
      items: [
        { text: 'Sessions', link: '/concepts/sessions' },
        { text: 'Models', link: '/concepts/models' },
        { text: 'Tools', link: '/concepts/tools' },
        { text: 'Harnesses', link: '/concepts/harnesses' },
        { text: 'Skills', link: '/concepts/skills' },
        { text: 'MCP', link: '/concepts/mcp' },
        { text: 'Triggers', link: '/concepts/triggers' },
        { text: 'Channels', link: '/concepts/channels' },
        { text: 'Telemetry', link: '/concepts/telemetry' },
      ],
    },
  ],
});
