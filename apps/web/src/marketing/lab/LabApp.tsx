/*
 * Design-lab entry (its own lazy bundle, non-production). Loads the marketing tokens
 * plus the lab-only styles, then renders the experiment board.
 */
import type { JSX } from 'react';
import { DesignLab } from './DesignLab';
import '../marketing.css';
import './lab.css';

export function LabApp(): JSX.Element {
  return <DesignLab />;
}
