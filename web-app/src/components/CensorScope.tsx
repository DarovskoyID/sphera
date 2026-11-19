import React, { createContext, useContext } from 'react';

const CensorOffCtx = createContext(false);

/**
 * Turns the content filter off for everything rendered inside.
 *
 * Used for the personal diary: those entries are the author's own private
 * notes to themselves, so masking their wording would be pointless — they
 * wrote it, they are the only reader, and there is nobody to be protected
 * from. Every censoring component checks this before doing anything.
 */
export const CensorOff: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <CensorOffCtx.Provider value={true}>{children}</CensorOffCtx.Provider>
);

export const useCensorOff = () => useContext(CensorOffCtx);
