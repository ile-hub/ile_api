-- Additive, public projections only. No records/status history are rewritten.
CREATE FUNCTION leri_discovery(p_after uuid DEFAULT NULL, p_limit integer DEFAULT 21)
RETURNS SETOF jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT leri_public_profile(u.id) FROM users u
  JOIN users caller ON caller.id=nullif(current_setting('app.current_user_id',true),'')::uuid
  LEFT JOIN renter_profiles rp ON rp.user_id=u.id
  LEFT JOIN landlord_profiles lp ON lp.user_id=u.id
  WHERE caller.role IN ('renter','landlord') AND u.role IN ('renter','landlord') AND caller.role<>u.role
    AND CASE WHEN u.role='renter' THEN rp.discoverable ELSE lp.discoverable END
    AND (p_after IS NULL OR u.id>p_after)
  ORDER BY u.id LIMIT greatest(1,least(p_limit,51));
$$;
REVOKE ALL ON FUNCTION leri_discovery(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION leri_discovery(uuid,integer) TO app_user;
