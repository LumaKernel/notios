import { Box, Text } from 'ink';
import type { FC } from 'react';
import React, { useCallback } from 'react';
import stringLength from 'string-length';
import wcslice from 'wcslice';
import wcwidth from 'wcwidth';
import BoxWithSize from './box_with_size';

export interface ScrollableProps {
  lines: string[];
  top?: number;
  left?: number;
}
const Scrollable: FC<ScrollableProps> = ({ lines, top = 0, left = 0 }) => {
  const trimmedLines = useCallback(
    ({ height, width }: { height: number; width: number }) => {
      return lines.slice(top, top + height).map((line, i) => {
        const wcstart = left;
        const wcend = left + width - 2.5;
        const text = wcslice(line, wcstart, wcend);
        return {
          abs: top + i,
          left: wcstart > 0 ? '~' : '',
          text,
          right: text !== wcslice(line, wcstart) ? '~' : '',
        };
      });
    },
    [lines, top, left],
  );
  return (
    <BoxWithSize height="100%" width="100%" flexDirection="column">
      {({ width, height }) =>
        trimmedLines({ width, height }).map(({ text, left, right, abs }) => (
          <Box key={abs}>
            <Text color="gray" italic>
              {left}
            </Text>
            <Box width={wcwidth(text) - (text.length - stringLength(text))}>
              <Text wrap="end">{text}</Text>
            </Box>
            <Text color="gray" italic>
              {right}
            </Text>
          </Box>
        ))
      }
    </BoxWithSize>
  );
};

export default Scrollable;
