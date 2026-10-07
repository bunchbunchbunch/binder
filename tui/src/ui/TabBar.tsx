import React from 'react';
import { Box, Text } from 'ink';
import type { Tab } from '../store.js';
import { tabLabel, visibleTabs } from './tabLayout.js';

export function TabBar({ tabs, active, width, frame }: { tabs: Tab[]; active: number; width: number; frame: number }) {
  if (!tabs.length) {
    return (
      <Box height={1}>
        <Text dimColor>no tabs yet: type a prompt below</Text>
      </Box>
    );
  }
  const labels = tabs.map((t) => tabLabel(t, frame));
  const { indices, left, right } = visibleTabs(labels, active, width);
  return (
    <Box height={1}>
      <Text dimColor>{left ? '‹ ' : '  '}</Text>
      {indices.map((i, n) => {
        const tab = tabs[i];
        const isActive = i === active;
        const color = tab.status === 'error' ? 'red' : tab.status === 'running' ? 'yellow' : undefined;
        return (
          <React.Fragment key={tab.id}>
            {n > 0 && <Text dimColor> │ </Text>}
            <Text bold={isActive} inverse={isActive} color={color} dimColor={!isActive && tab.status === 'queued'}>
              {' ' + labels[i] + ' '}
            </Text>
          </React.Fragment>
        );
      })}
      <Text dimColor>{right ? ' ›' : ''}</Text>
    </Box>
  );
}
