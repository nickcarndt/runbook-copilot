// Demo runbooks for Milestone 1
export const demoRunbooks = [
  {
    id: '1',
    title: 'Database Connection Issue',
    content: `# Database Connection Issue

## Symptoms
- Application cannot connect to database
- Error: "Connection refused" or "Connection timeout"
- High latency on database queries

## Steps to Resolve

1. Check database service status
   - Verify database is running: \`systemctl status postgresql\`
   - Check logs: \`journalctl -u postgresql -n 50\`

2. Verify network connectivity
   - Test connection: \`telnet db-host 5432\`
   - Check firewall rules

3. Review connection pool settings
   - Check max_connections in postgresql.conf
   - Review application connection pool size

4. Restart database if needed
   - \`sudo systemctl restart postgresql\`

## Prevention
- Monitor connection pool usage
- Set up alerts for connection errors
- Regular database health checks`,
  },
  {
    id: '2',
    title: 'High Memory Usage',
    content: `# High Memory Usage

## Symptoms
- Server memory usage > 90%
- Application slowdown
- OOM (Out of Memory) errors

## Steps to Resolve

1. Identify memory consumers
   - Check top processes: \`top -o %MEM\`
   - Review memory stats: \`free -h\`

2. Check application memory leaks
   - Review recent deployments
   - Check for unclosed connections/resources

3. Restart high-memory processes
   - Identify and restart problematic services
   - Consider scaling horizontally

4. Clear caches if applicable
   - Application caches
   - System caches (if safe)

## Prevention
- Set memory limits on containers
- Monitor memory trends
- Regular memory leak audits`,
  },
  {
    id: '3',
    title: 'API Rate Limiting',
    content: `# API Rate Limiting

## Symptoms
- 429 Too Many Requests errors
- API calls being rejected
- User complaints about service unavailability

## Steps to Resolve

1. Check current rate limit settings
   - Review API gateway configuration
   - Check application rate limiters

2. Identify source of high traffic
   - Review access logs
   - Check for DDoS or legitimate traffic spike

3. Adjust rate limits if needed
   - Temporarily increase limits for legitimate traffic
   - Block malicious IPs if applicable

4. Scale infrastructure
   - Add more API instances
   - Increase rate limit thresholds

## Prevention
- Monitor API usage patterns
- Set up alerts for rate limit breaches
- Implement gradual rate limiting`,
  },
];

export function searchRunbooks(query: string): Array<{ id: string; title: string; content: string; relevance: number }> {
  const lowerQuery = query.toLowerCase();
  return demoRunbooks
    .map(runbook => {
      const titleMatch = runbook.title.toLowerCase().includes(lowerQuery) ? 10 : 0;
      const contentMatch = (runbook.content.toLowerCase().match(new RegExp(lowerQuery, 'g')) || []).length;
      const relevance = titleMatch + contentMatch;
      return { ...runbook, relevance };
    })
    .filter(r => r.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance);
}

