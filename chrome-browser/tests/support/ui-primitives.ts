/**
 * Test double for `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * The published package's Node entry pulls a long chain of browser-only
 * dependencies (shiki, simple-icons, CSS modules) that the Web shell supplies
 * at runtime through its module table; loading it under Node is neither
 * possible nor meaningful. The only client module under test here imports two
 * icon components, so those are stubbed with the same call surface. Type-only
 * uses (`IconProps`) are erased and need no stub member.
 */

/** Stand-in for the checkmark icon: renders nothing. */
export function IconCheckOutlineRegular(): null {
  return null
}

/** Stand-in for the chevron icon: renders nothing. */
export function IconChevronDownOutlineRegular(): null {
  return null
}
