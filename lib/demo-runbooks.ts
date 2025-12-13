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
- Connection pool exhaustion warnings
- Application threads waiting for database connections

## Initial Diagnosis

### Check Database Service Status
First, verify that the database service is actually running:
- Run: \`systemctl status postgresql\`
- Check for any service failures or restarts
- Review system logs: \`journalctl -u postgresql -n 100\`
- Look for error patterns or repeated failures

### Verify Network Connectivity
Network issues are a common cause of connection problems:
- Test basic connectivity: \`telnet db-host 5432\` or \`nc -zv db-host 5432\`
- Verify DNS resolution: \`nslookup db-host\`
- Check firewall rules: \`iptables -L -n | grep 5432\`
- Review network latency: \`ping db-host\`
- Check for network partitions or routing issues

### Review Connection Pool Settings
Connection pool misconfiguration can cause connection failures:
- Check max_connections in postgresql.conf
- Review application connection pool size (should be < max_connections)
- Verify connection timeout settings
- Check for connection leaks in application code
- Review connection pool monitoring metrics

## Steps to Resolve

### Step 1: Restart Database Service
If the service is running but unresponsive:
- Graceful restart: \`sudo systemctl restart postgresql\`
- Wait for service to fully start before testing
- Monitor logs during restart: \`journalctl -u postgresql -f\`
- Verify service health after restart

### Step 2: Clear Connection Pool
If connections are stuck:
- Restart application to clear connection pool
- Or use connection pool management commands if available
- Monitor active connections: \`SELECT count(*) FROM pg_stat_activity;\`
- Kill idle connections if necessary: \`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = 'idle';\`

### Step 3: Adjust Connection Limits
If legitimate traffic is being blocked:
- Temporarily increase max_connections if needed
- Review and optimize application connection pool size
- Consider connection pooling middleware (PgBouncer)
- Update connection timeout values

### Step 4: Investigate Root Cause
For persistent issues:
- Review database logs for patterns
- Check for database locks or long-running queries
- Review application error logs
- Consider database resource constraints (CPU, memory, disk I/O)

## Prevention
- Monitor connection pool usage with alerts
- Set up alerts for connection errors (threshold: > 10 errors/min)
- Regular database health checks (daily automated checks)
- Implement connection pool monitoring dashboards
- Review connection patterns during peak traffic
- Set up automated connection leak detection
- Document connection pool best practices for developers`,
  },
  {
    id: '2',
    title: 'High Memory Usage',
    content: `# High Memory Usage

## Symptoms
- Server memory usage > 90%
- Application slowdown and increased response times
- OOM (Out of Memory) errors in logs
- System swap usage increasing
- Process memory consumption growing over time
- Memory-related crashes or restarts

## Initial Diagnosis

### Identify Memory Consumers
Start by understanding what's using memory:
- Check top processes: \`top -o %MEM\` or \`htop\`
- Review memory stats: \`free -h\` and \`cat /proc/meminfo\`
- Check per-process memory: \`ps aux --sort=-%mem | head -20\`
- Review container memory if using Docker: \`docker stats\`
- Check for memory leaks in application metrics

### Check Application Memory Leaks
Application-level issues are common:
- Review recent deployments for memory-related changes
- Check for unclosed database connections
- Look for unclosed file handles or streams
- Review caching implementations (check for unbounded cache growth)
- Analyze garbage collection metrics if available
- Review application memory profiling data

### System-Level Memory Analysis
System resources may be constrained:
- Check system memory pressure: \`vmstat 1 10\`
- Review swap usage: \`swapon --show\`
- Check for memory fragmentation
- Review kernel memory usage: \`cat /proc/meminfo | grep -i slab\`
- Analyze memory allocation patterns

## Steps to Resolve

### Step 1: Restart High-Memory Processes
Immediate relief for memory pressure:
- Identify problematic services using most memory
- Restart services one at a time to avoid downtime
- Monitor memory after each restart
- Consider graceful restarts vs. forced kills
- Document which services were restarted

### Step 2: Clear Application Caches
If caches are consuming too much memory:
- Clear application-level caches (if safe to do so)
- Review cache eviction policies
- Consider reducing cache size limits
- Clear system caches only if absolutely necessary: \`sync && echo 3 > /proc/sys/vm/drop_caches\`
- Monitor memory after cache clearing

### Step 3: Scale Infrastructure
For persistent high memory usage:
- Scale horizontally: add more application instances
- Scale vertically: increase instance memory (if possible)
- Implement auto-scaling based on memory metrics
- Consider moving memory-intensive workloads to dedicated instances
- Review and optimize memory-intensive operations

### Step 4: Optimize Memory Usage
Long-term improvements:
- Review and fix memory leaks in application code
- Optimize data structures and algorithms
- Implement memory-efficient caching strategies
- Review and optimize database query memory usage
- Consider implementing memory limits per process/container

## Prevention
- Set memory limits on containers: \`docker run --memory="512m"\`
- Monitor memory trends with time-series dashboards
- Set up alerts for memory usage > 80%
- Regular memory leak audits (weekly code reviews)
- Implement memory profiling in CI/CD pipeline
- Document memory usage patterns and optimization strategies
- Regular capacity planning reviews
- Implement circuit breakers for memory-intensive operations`,
  },
  {
    id: '3',
    title: 'API Rate Limiting',
    content: `# API Rate Limiting

## Symptoms
- 429 Too Many Requests errors in API responses
- API calls being rejected or throttled
- User complaints about service unavailability
- Increased error rates in monitoring dashboards
- API response times degrading
- Legitimate users unable to access services

## Initial Diagnosis

### Check Current Rate Limit Settings
Understand the current configuration:
- Review API gateway rate limit configuration
- Check application-level rate limiters
- Review per-endpoint rate limit rules
- Verify rate limit headers in API responses
- Check rate limit configuration in load balancers
- Review rate limit policies and rules

### Identify Source of High Traffic
Determine if traffic is legitimate or malicious:
- Review access logs for traffic patterns
- Check for DDoS attacks or bot traffic
- Analyze traffic by IP address and user agent
- Review API usage by endpoint
- Check for legitimate traffic spikes (product launches, marketing campaigns)
- Identify any misconfigured clients causing excessive requests

### Analyze Traffic Patterns
Understand the nature of the traffic:
- Review request rate over time (hourly/daily patterns)
- Check for specific endpoints receiving excessive traffic
- Analyze geographic distribution of traffic
- Review user behavior patterns
- Check for retry storms or cascading failures
- Identify any automated systems making excessive requests

## Steps to Resolve

### Step 1: Adjust Rate Limits Temporarily
For legitimate traffic spikes:
- Temporarily increase rate limits for affected endpoints
- Implement gradual rate limiting (soft limits before hard limits)
- Consider per-user vs. per-IP rate limiting
- Monitor impact of rate limit changes
- Document temporary changes and review timeline

### Step 2: Block Malicious Traffic
If traffic is malicious:
- Block malicious IPs at firewall/load balancer level
- Implement IP-based rate limiting
- Use WAF (Web Application Firewall) rules
- Consider implementing CAPTCHA for suspicious traffic
- Review and update DDoS protection settings
- Coordinate with security team if needed

### Step 3: Scale Infrastructure
For legitimate high traffic:
- Add more API instances to handle load
- Scale horizontally across multiple regions
- Increase rate limit thresholds to match capacity
- Implement auto-scaling based on request rate
- Review and optimize API endpoint performance
- Consider implementing request queuing

### Step 4: Optimize API Performance
Reduce load through optimization:
- Optimize slow endpoints that may cause retries
- Implement response caching where appropriate
- Review and optimize database queries
- Consider implementing request batching
- Review API design for efficiency improvements
- Implement connection pooling and resource optimization

## Prevention
- Monitor API usage patterns with dashboards
- Set up alerts for rate limit breaches (> 50% of limit)
- Implement gradual rate limiting (warn before hard limit)
- Regular review of rate limit policies (monthly)
- Document rate limits in API documentation
- Implement rate limit headers in all API responses
- Set up automated testing for rate limit behavior
- Regular capacity planning based on traffic trends
- Implement circuit breakers for downstream services`,
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
